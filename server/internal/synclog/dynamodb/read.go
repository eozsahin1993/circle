package dynamodb

import (
	"context"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/synclog"
	"circle-relay/internal/util/dynamoutil"
)

// Read never deletes or evicts — nothing to reconcile against
// retention, unlike an earlier TTL-eviction design this store replaced:
// entries are retained and immutable forever now, so there's no expiry
// to reconcile against. A circle with no control state yet (never
// Bootstrapped) reads back
// as empty rather than an error — Read is used for ordinary catch-up
// sync, where "nothing here yet" is a normal state, not a caller mistake.
func (s *Store) Read(ctx context.Context, syncID string, ns synclog.Namespace, sinceEpoch int64) (synclog.FetchResult, error) {
	if !ns.Valid() {
		return synclog.FetchResult{}, synclog.ErrInvalidNamespace
	}

	control, err := s.getControlState(ctx, syncID, false)
	if errors.Is(err, synclog.ErrCircleNotFound) {
		return synclog.FetchResult{Entries: []synclog.LogEntry{}}, nil
	}
	if err != nil {
		return synclog.FetchResult{}, err
	}
	currentEpoch := control.counter(ns)

	// Loops rather than one Query call: DynamoDB caps a single response at
	// 1MB regardless of readPageSize — an unpaginated call would silently
	// truncate once a namespace's backlog crosses that size.
	entries := make([]synclog.LogEntry, 0, readPageSize)
	var exclusiveStartKey map[string]types.AttributeValue
	for len(entries) < readPageSize {
		queryOut, err := s.client.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.tableName),
			KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND %s BETWEEN :lower AND :upper", dynamoutil.PKAttr, dynamoutil.SKAttr)),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk":    &types.AttributeValueMemberS{Value: syncID},
				":lower": &types.AttributeValueMemberS{Value: entrySK(ns, sinceEpoch+1)},
				":upper": &types.AttributeValueMemberS{Value: entrySKUpperBound(ns)},
			},
			ScanIndexForward:  aws.Bool(true),
			Limit:             aws.Int32(int32(readPageSize - len(entries))),
			ExclusiveStartKey: exclusiveStartKey,
		})
		if err != nil {
			return synclog.FetchResult{}, err
		}

		for _, item := range queryOut.Items {
			epoch, err := dynamoutil.AttrInt(item, "epoch")
			if err != nil {
				return synclog.FetchResult{}, err
			}
			keyVersion, err := dynamoutil.AttrInt(item, "keyVersion")
			if err != nil {
				return synclog.FetchResult{}, err
			}
			receivedAt, err := dynamoutil.AttrInt(item, "receivedAt")
			if err != nil {
				return synclog.FetchResult{}, err
			}
			// Absent on a DeleteEntry-stripped row (never on any other kind —
			// everything else always writes it). Empty rather than an error:
			// the client's own decrypt already treats malformed/absent
			// ciphertext as unreadable and skips it, same as any entry it
			// lacks the key version for.
			var meta []byte
			if blobAttr, ok := item["encryptedMeta"].(*types.AttributeValueMemberB); ok {
				meta = blobAttr.Value
			}
			// Absent on rows written by Rotate/ChangeAuthority/DeleteCircle,
			// and on any row from before this field existed — AttrString
			// returns "" for both, same as commit's own omit-when-empty
			// write side.
			authorIdentityPublicKey, _ := dynamoutil.AttrString(item, "authorIdentityPublicKey")
			deletedAt, _ := dynamoutil.AttrInt(item, "deletedAt")
			entries = append(entries, synclog.LogEntry{
				Epoch:                   epoch,
				KeyVersion:              keyVersion,
				EncryptedMeta:           meta,
				ReceivedAt:              receivedAt,
				DeletedAt:               deletedAt,
				AuthorIdentityPublicKey: authorIdentityPublicKey,
			})
		}

		if queryOut.LastEvaluatedKey == nil {
			break
		}
		exclusiveStartKey = queryOut.LastEvaluatedKey
	}
	// No sort needed: ScanIndexForward already returns each page in
	// ascending epoch order, and consecutive pages continue that same
	// order, so entries is already fully sorted by the time this loop ends.

	return synclog.FetchResult{Entries: entries, CurrentEpoch: currentEpoch}, nil
}

// Peek is Read's cheap half exposed for polling — see synclog.LogStore.Peek.
// A requested syncID with no #control item is simply absent from the
// result, the per-item analog of getControlState's ErrCircleNotFound.
func (s *Store) Peek(ctx context.Context, syncIDs []string) (map[string]synclog.Epochs, error) {
	result := make(map[string]synclog.Epochs, len(syncIDs))
	if len(syncIDs) == 0 {
		return result, nil
	}

	// Deduplicated because BatchGetItem rejects the whole request with a
	// ValidationException if the same key appears twice — and a caller
	// asking about the same circle twice wants an answer, not an error.
	seen := make(map[string]bool, len(syncIDs))
	keys := make([]map[string]types.AttributeValue, 0, len(syncIDs))
	for _, syncID := range syncIDs {
		if seen[syncID] {
			continue
		}
		seen[syncID] = true
		keys = append(keys, controlKey(syncID))
	}

	requestItems := map[string]types.KeysAndAttributes{
		s.tableName: {Keys: keys, ConsistentRead: aws.Bool(false)},
	}
	for attempt := 0; len(requestItems) > 0; attempt++ {
		// UnprocessedKeys means DynamoDB throttled part of the batch.
		// Resubmitting immediately would add load to a table already
		// pushing back (and spin a Lambda invocation hot doing it), so
		// each retry waits a little longer than the last.
		if attempt > 0 {
			if err := sleepBackoff(ctx, attempt); err != nil {
				return nil, err
			}
		}

		out, err := s.client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: requestItems})
		if err != nil {
			return nil, err
		}
		for _, item := range out.Responses[s.tableName] {
			syncID, ok := dynamoutil.AttrString(item, dynamoutil.PKAttr)
			if !ok {
				continue
			}
			epochs, err := parseControlEpochs(item)
			if err != nil {
				return nil, err
			}
			result[syncID] = epochs
		}
		requestItems = out.UnprocessedKeys
	}
	return result, nil
}
