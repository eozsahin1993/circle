package dynamodb

import (
	"context"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/dynamoutil"
	"circle-relay/internal/synclog"
)

// findEntryByID resolves a content-namespace entry by id via the
// entryId-index GSI, then fetches the full row from the base table (the
// GSI is KEYS_ONLY). ErrEntryNotFound if absent or in a different circle.
//
// The GSI is only eventually consistent, so a post deleted right after
// being posted can briefly not show up yet — retried with the same
// backoff Peek uses for its own eventually-consistent reads, rather than
// failing a legitimate delete on timing.
func (s *Store) findEntryByID(ctx context.Context, syncID, entryID string) (synclog.LogEntry, error) {
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

// DeleteEntry strips a post's payload and appends its tombstone — see
// synclog.LogStore.DeleteEntry.
func (s *Store) DeleteEntry(ctx context.Context, deletion synclog.EntryDeletion) (synclog.CommitResult, error) {
	if existing, err := s.lookupIdempotencyMarker(ctx, deletion.SyncID, synclog.NamespaceContent, deletion.TombstoneEntryID); err != nil {
		return synclog.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	post, err := s.findEntryByID(ctx, deletion.SyncID, deletion.TargetEntryID)
	if err != nil {
		return synclog.CommitResult{}, err
	}

	authorizedBy := post.AuthorIdentityPublicKey
	if verifyAuthoritySignature(post.AuthorIdentityPublicKey, deletion.Message(), deletion.AuthorSignature) != nil {
		if deletion.AuthorityPublicKey == "" || len(deletion.AuthoritySignature) == 0 {
			return synclog.CommitResult{}, synclog.ErrEntryNotAuthorized
		}
		if err := s.VerifyAuthoritySignature(ctx, deletion.SyncID, deletion.AuthorityPublicKey, deletion.Message(), deletion.AuthoritySignature); err != nil {
			return synclog.CommitResult{}, err
		}
		authorizedBy = deletion.AuthorityPublicKey
	}

	expectedHash, hashErr := hashWriteToken(deletion.WriteToken)

	result, _, err := s.casCommit(ctx, deletion.SyncID, synclog.NamespaceContent, deletion.TombstoneEntryID, entryFields{
		EncryptedPayload:        deletion.EncryptedPayload,
		KeyVersion:              deletion.KeyVersion,
		AuthorIdentityPublicKey: authorizedBy,
	}, func(control *controlState, epoch, receivedAt int64) (casPlan, error) {
		if hashErr != nil || control.writeTokenHash != expectedHash {
			return casPlan{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return casPlan{}, synclog.ErrCircleDeleted
		}

		// Same CAS condition as Append, so a stale or racing write token
		// fails the whole transaction up front.
		controlUpdate := types.Update{
			TableName:           aws.String(s.tableName),
			Key:                 controlKey(deletion.SyncID),
			UpdateExpression:    aws.String("SET contentCounter = :next"),
			ConditionExpression: aws.String("writeTokenHash = :hash AND contentCounter = :current AND attribute_not_exists(deletedAt)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":hash":    &types.AttributeValueMemberS{Value: expectedHash},
				":current": &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch-1, 10)},
				":next":    &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
			},
		}

		// Strip the original post, in the same transaction as the counter
		// bump and the tombstone commit builds around this plan.
		stripKey, stripExpr, stripValues := stripEntryFields(deletion.SyncID, entrySK(synclog.NamespaceContent, post.Epoch), receivedAt, authorizedBy)
		strip := types.TransactWriteItem{Update: &types.Update{
			TableName:                 aws.String(s.tableName),
			Key:                       stripKey,
			UpdateExpression:          stripExpr,
			ExpressionAttributeValues: stripValues,
		}}

		return casPlan{Control: controlUpdate, Extra: []types.TransactWriteItem{strip}}, nil
	})
	return result, err
}
