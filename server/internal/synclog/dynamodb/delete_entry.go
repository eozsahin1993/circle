package dynamodb

import (
	"context"
	"fmt"
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

	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		control, err := s.getControlState(ctx, deletion.SyncID, true)
		if err != nil {
			return synclog.CommitResult{}, err
		}
		if hashErr != nil || control.writeTokenHash != expectedHash {
			return synclog.CommitResult{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return synclog.CommitResult{}, synclog.ErrCircleDeleted
		}

		current := control.contentCounter
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		items := []types.TransactWriteItem{
			// 1. Bump the counter — same CAS condition as Append, so a stale
			// or racing write token fails the whole transaction up front.
			{
				Update: &types.Update{
					TableName:           aws.String(s.tableName),
					Key:                 controlKey(deletion.SyncID),
					UpdateExpression:    aws.String("SET contentCounter = :next"),
					ConditionExpression: aws.String("writeTokenHash = :hash AND contentCounter = :current AND attribute_not_exists(deletedAt)"),
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":hash":    &types.AttributeValueMemberS{Value: expectedHash},
						":current": &types.AttributeValueMemberN{Value: strconv.FormatInt(current, 10)},
						":next":    &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
					},
				},
			},
			// 2. Strip the original post.
			{
				Update: &types.Update{
					TableName:        aws.String(s.tableName),
					Key:              map[string]types.AttributeValue{dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: deletion.SyncID}, dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: entrySK(synclog.NamespaceContent, post.Epoch)}},
					UpdateExpression: aws.String("REMOVE encryptedMeta SET deletedAt = :t, deletedBy = :who"),
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":t":   &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
						":who": &types.AttributeValueMemberS{Value: authorizedBy},
					},
				},
			},
			// 3. Append the tombstone, so already-synced devices hide it too.
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item: map[string]types.AttributeValue{
						dynamoutil.PKAttr:         &types.AttributeValueMemberS{Value: deletion.SyncID},
						dynamoutil.SKAttr:         &types.AttributeValueMemberS{Value: entrySK(synclog.NamespaceContent, nextEpoch)},
						"epoch":                   &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
						"keyVersion":              &types.AttributeValueMemberN{Value: strconv.FormatInt(deletion.KeyVersion, 10)},
						"encryptedMeta":           &types.AttributeValueMemberB{Value: deletion.EncryptedPayload},
						"receivedAt":              &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
						"entryId":                 &types.AttributeValueMemberS{Value: deletion.TombstoneEntryID},
						"authorIdentityPublicKey": &types.AttributeValueMemberS{Value: authorizedBy},
					},
				},
			},
			// 4. The tombstone's own idempotency marker, so a retry converges.
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item: map[string]types.AttributeValue{
						dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: deletion.SyncID},
						dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: idemSK(synclog.NamespaceContent, deletion.TombstoneEntryID)},
						"epoch":           &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
						"receivedAt":      &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
						"expiresAt":       &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt/1000+int64(idemMarkerTTL.Seconds()), 10)},
					},
					ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s)", dynamoutil.PKAttr)),
				},
			},
		}

		_, err = s.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
		if err == nil {
			return synclog.CommitResult{Epoch: nextEpoch, ReceivedAt: receivedAt}, nil
		}
		if converged, convErr := s.convergeOnRace(ctx, deletion.SyncID, synclog.NamespaceContent, deletion.TombstoneEntryID, err); convErr != nil {
			return synclog.CommitResult{}, convErr
		} else if converged != nil {
			return *converged, nil
		}
	}
	return synclog.CommitResult{}, synclog.ErrConcurrentModification
}
