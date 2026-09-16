package dynamodb

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/synclog"
	"circle-relay/internal/util/dynamoutil"
)

// FindEntry resolves a content-namespace entry by id via the
// entryId-index GSI, then fetches the full row from the base table (the
// GSI is KEYS_ONLY). ErrEntryNotFound if absent or in a different circle.
//
// The GSI is only eventually consistent, so a post deleted right after
// being posted can briefly not show up yet — retried with the same
// backoff Peek uses for its own eventually-consistent reads, rather than
// failing a legitimate delete on timing.
func (s *Store) FindEntry(ctx context.Context, syncID, entryID string) (synclog.LogEntry, error) {
	var queryOut *dynamodb.QueryOutput
	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		if attempt > 0 {
			if err := sleepBackoff(ctx, attempt); err != nil {
				return synclog.LogEntry{}, err
			}
		}
		out, err := s.client.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.tableName),
			IndexName:              aws.String(EntryIDIndexName),
			KeyConditionExpression: aws.String("entryId = :id"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":id": &types.AttributeValueMemberS{Value: entryID},
			},
			Limit: aws.Int32(1),
		})
		if err != nil {
			return synclog.LogEntry{}, err
		}
		if len(out.Items) > 0 {
			queryOut = out
			break
		}
	}
	if queryOut == nil {
		return synclog.LogEntry{}, synclog.ErrEntryNotFound
	}
	pk, _ := dynamoutil.AttrString(queryOut.Items[0], dynamoutil.PKAttr)
	if pk != syncID {
		return synclog.LogEntry{}, synclog.ErrEntryNotFound
	}
	sk, _ := dynamoutil.AttrString(queryOut.Items[0], dynamoutil.SKAttr)
	// The GSI spans both namespaces, but only content entries are
	// deletable this way — reject a meta entryId rather than let the
	// caller strip whatever content row happens to sit at that epoch.
	if !strings.HasPrefix(sk, string(synclog.NamespaceContent)+"#") {
		return synclog.LogEntry{}, synclog.ErrEntryNotFound
	}

	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.tableName),
		Key:            map[string]types.AttributeValue{dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pk}, dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: sk}},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return synclog.LogEntry{}, err
	}
	if out.Item == nil {
		return synclog.LogEntry{}, synclog.ErrEntryNotFound
	}
	epoch, err := dynamoutil.AttrInt(out.Item, "epoch")
	if err != nil {
		return synclog.LogEntry{}, err
	}
	authorIdentityPublicKey, _ := dynamoutil.AttrString(out.Item, "authorIdentityPublicKey")
	return synclog.LogEntry{Epoch: epoch, AuthorIdentityPublicKey: authorIdentityPublicKey}, nil
}

// DeleteEntry strips targetEpoch's payload and appends its tombstone —
// see LogStore.DeleteEntry for why requiredAuthorityPublicKey is checked
// here rather than by the caller.
func (s *Store) DeleteEntry(ctx context.Context, syncID, tombstoneEntryID string, targetEpoch int64, encryptedPayload []byte, keyVersion int64, writeTokenHash, authorizedBy, requiredAuthorityPublicKey string) (synclog.CommitResult, error) {
	if existing, err := s.lookupIdempotencyMarker(ctx, syncID, synclog.NamespaceContent, tombstoneEntryID); err != nil {
		return synclog.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	result, err := s.casCommit(ctx, syncID, synclog.NamespaceContent, tombstoneEntryID, entryFields{
		EncryptedPayload:        encryptedPayload,
		KeyVersion:              keyVersion,
		AuthorIdentityPublicKey: authorizedBy,
	}, func(control *controlState, epoch, receivedAt int64) (casPlan, error) {
		if control.writeTokenHash != writeTokenHash {
			return casPlan{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return casPlan{}, synclog.ErrCircleDeleted
		}
		if requiredAuthorityPublicKey != "" && !control.authoritySet[requiredAuthorityPublicKey] {
			return casPlan{}, synclog.ErrAuthorityNotRecognized
		}

		// Same CAS condition as Append, so a stale or racing write token
		// fails the whole transaction up front. The admin path adds an
		// authoritySet check re-verified atomically alongside it, since a
		// key that was demoted between Service's checks and this commit
		// must not still land the tombstone.
		condition := "writeTokenHash = :hash AND contentCounter = :current AND attribute_not_exists(deletedAt)"
		values := map[string]types.AttributeValue{
			":hash":    &types.AttributeValueMemberS{Value: writeTokenHash},
			":current": &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch-1, 10)},
			":next":    &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
		}
		if requiredAuthorityPublicKey != "" {
			condition += " AND contains(authoritySet, :signer)"
			values[":signer"] = &types.AttributeValueMemberS{Value: requiredAuthorityPublicKey}
		}
		controlUpdate := types.Update{
			TableName:                 aws.String(s.tableName),
			Key:                       controlKey(syncID),
			UpdateExpression:          aws.String("SET contentCounter = :next"),
			ConditionExpression:       aws.String(condition),
			ExpressionAttributeValues: values,
		}

		// Strip the original post, in the same transaction as the counter
		// bump and the tombstone commit builds around this plan.
		stripKey, stripExpr, stripValues := stripEntryFields(syncID, entrySK(synclog.NamespaceContent, targetEpoch), receivedAt, authorizedBy)
		strip := types.TransactWriteItem{Update: &types.Update{
			TableName:                 aws.String(s.tableName),
			Key:                       stripKey,
			UpdateExpression:          stripExpr,
			ConditionExpression:       aws.String(fmt.Sprintf("attribute_exists(%s)", dynamoutil.PKAttr)),
			ExpressionAttributeValues: stripValues,
		}}

		return casPlan{Control: controlUpdate, Extra: []types.TransactWriteItem{strip}}, nil
	})
	return result, err
}
