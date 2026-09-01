// Package dynamodb implements ports.LogStore against a single DynamoDB
// table.
package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/ports"
)

// DefaultRingBufferSize is configurable per server/DESIGN.md.
const DefaultRingBufferSize = 2000

type LogStore struct {
	client         *dynamodb.Client
	tableName      string
	ringBufferSize int64
}

func NewLogStore(client *dynamodb.Client, tableName string, ringBufferSize int64) *LogStore {
	if ringBufferSize <= 0 {
		ringBufferSize = DefaultRingBufferSize
	}
	return &LogStore{client: client, tableName: tableName, ringBufferSize: ringBufferSize}
}

var _ ports.LogStore = (*LogStore)(nil)

// CommitEntry assigns an epoch, then writes the log entry and the
// idempotency marker in one TransactWriteItems call — both happen or
// neither does. The epoch assignment itself is a separate, non-
// transactional counter bump; if the transaction that follows fails, that
// epoch just goes unused (a harmless gap, same as ring-buffer trimming
// already produces), which is a fine trade for keeping "content written"
// and "idempotency recorded" atomically linked.
func (s *LogStore) CommitEntry(ctx context.Context, circleLogID, entryID string, encryptedMeta []byte) (ports.CommitResult, error) {
	// Consistent read first: a pure retry of an already-committed entryID
	// returns here without ever touching the counter.
	if existing, err := s.lookupIdempotencyMarker(ctx, circleLogID, entryID); err != nil {
		return ports.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	epoch, err := s.nextEpochAtomically(ctx, circleLogID)
	if err != nil {
		return ports.CommitResult{}, err
	}
	receivedAt := nowMillis()

	_, err = s.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item: map[string]types.AttributeValue{
						pkAttr:          &types.AttributeValueMemberS{Value: circleLogID},
						skAttr:          &types.AttributeValueMemberS{Value: epochSK(epoch)},
						"epoch":         &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
						"encryptedMeta": &types.AttributeValueMemberB{Value: encryptedMeta},
						"receivedAt":    &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
						// Duplicated onto the log entry (already known server-side,
						// already stored in the idem item's own sort key) so Trim
						// can clean up the matching idempotency marker.
						"entryID": &types.AttributeValueMemberS{Value: entryID},
					},
				},
			},
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item: map[string]types.AttributeValue{
						pkAttr:       &types.AttributeValueMemberS{Value: circleLogID},
						skAttr:       &types.AttributeValueMemberS{Value: idemSK(entryID)},
						"epoch":      &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
						"receivedAt": &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
					},
					ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s)", pkAttr)),
				},
			},
		},
	})
	if err == nil {
		return ports.CommitResult{Epoch: epoch, ReceivedAt: receivedAt}, nil
	}

	// Someone else already committed this entryID — look up what they
	// recorded and return that, so a retry converges instead of erroring.
	var canceled *types.TransactionCanceledException
	if errors.As(err, &canceled) {
		if existing, lookupErr := s.lookupIdempotencyMarker(ctx, circleLogID, entryID); lookupErr == nil && existing != nil {
			return *existing, nil
		}
	}
	return ports.CommitResult{}, err
}

func (s *LogStore) nextEpochAtomically(ctx context.Context, circleLogID string) (int64, error) {
	out, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			pkAttr: &types.AttributeValueMemberS{Value: circleLogID},
			skAttr: &types.AttributeValueMemberS{Value: counterSK},
		},
		UpdateExpression: aws.String("ADD #counter :one SET oldestAvailableEpoch = if_not_exists(oldestAvailableEpoch, :one)"),
		ExpressionAttributeNames: map[string]string{
			"#counter": "counter",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":one": &types.AttributeValueMemberN{Value: "1"},
		},
		ReturnValues: types.ReturnValueUpdatedNew,
	})
	if err != nil {
		return 0, err
	}
	return attrInt(out.Attributes, "counter")
}

func (s *LogStore) lookupIdempotencyMarker(ctx context.Context, circleLogID, entryID string) (*ports.CommitResult, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			pkAttr: &types.AttributeValueMemberS{Value: circleLogID},
			skAttr: &types.AttributeValueMemberS{Value: idemSK(entryID)},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	epoch, err := attrInt(out.Item, "epoch")
	if err != nil {
		return nil, err
	}
	receivedAt, err := attrInt(out.Item, "receivedAt")
	if err != nil {
		return nil, err
	}
	return &ports.CommitResult{Epoch: epoch, ReceivedAt: receivedAt}, nil
}

func (s *LogStore) Read(ctx context.Context, circleLogID string, since int64) (ports.FetchSinceResult, error) {
	counterOut, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			pkAttr: &types.AttributeValueMemberS{Value: circleLogID},
			skAttr: &types.AttributeValueMemberS{Value: counterSK},
		},
	})
	if err != nil {
		return ports.FetchSinceResult{}, err
	}
	if counterOut.Item == nil {
		return ports.FetchSinceResult{Entries: []ports.LogEntry{}}, nil
	}
	latestEpoch, err := attrInt(counterOut.Item, "counter")
	if err != nil {
		return ports.FetchSinceResult{}, err
	}
	oldestAvailableEpoch, err := attrInt(counterOut.Item, "oldestAvailableEpoch")
	if err != nil {
		return ports.FetchSinceResult{}, err
	}

	lowerBound := since
	if lowerBound < oldestAvailableEpoch-1 {
		lowerBound = oldestAvailableEpoch - 1
	}

	queryOut, err := s.client.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.tableName),
		KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND %s BETWEEN :lower AND :upper", pkAttr, skAttr)),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":    &types.AttributeValueMemberS{Value: circleLogID},
			":lower": &types.AttributeValueMemberS{Value: epochSK(lowerBound + 1)},
			":upper": &types.AttributeValueMemberS{Value: epochSKUpperBound()},
		},
		ScanIndexForward: aws.Bool(true),
	})
	if err != nil {
		return ports.FetchSinceResult{}, err
	}

	entries := make([]ports.LogEntry, 0, len(queryOut.Items))
	for _, item := range queryOut.Items {
		epoch, err := attrInt(item, "epoch")
		if err != nil {
			return ports.FetchSinceResult{}, err
		}
		receivedAt, err := attrInt(item, "receivedAt")
		if err != nil {
			return ports.FetchSinceResult{}, err
		}
		blobAttr, ok := item["encryptedMeta"].(*types.AttributeValueMemberB)
		if !ok {
			return ports.FetchSinceResult{}, fmt.Errorf("entry at epoch %d missing encryptedMeta", epoch)
		}
		entries = append(entries, ports.LogEntry{Epoch: epoch, EncryptedMeta: blobAttr.Value, ReceivedAt: receivedAt})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Epoch < entries[j].Epoch })

	return ports.FetchSinceResult{
		Entries:              entries,
		LatestEpoch:          latestEpoch,
		OldestAvailableEpoch: oldestAvailableEpoch,
	}, nil
}

// Trim deletes entries past the retention window and advances
// oldestAvailableEpoch. Best-effort: not atomic with anything else.
func (s *LogStore) Trim(ctx context.Context, circleLogID string) error {
	counterOut, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			pkAttr: &types.AttributeValueMemberS{Value: circleLogID},
			skAttr: &types.AttributeValueMemberS{Value: counterSK},
		},
	})
	if err != nil || counterOut.Item == nil {
		return err
	}
	latestEpoch, err := attrInt(counterOut.Item, "counter")
	if err != nil {
		return err
	}
	oldestAvailable, err := attrInt(counterOut.Item, "oldestAvailableEpoch")
	if err != nil {
		return err
	}

	cutoff := latestEpoch - s.ringBufferSize
	if cutoff < oldestAvailable {
		return nil
	}

	for epoch := oldestAvailable; epoch <= cutoff; epoch++ {
		out, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: aws.String(s.tableName),
			Key: map[string]types.AttributeValue{
				pkAttr: &types.AttributeValueMemberS{Value: circleLogID},
				skAttr: &types.AttributeValueMemberS{Value: epochSK(epoch)},
			},
			ReturnValues: types.ReturnValueAllOld,
		})
		if err != nil {
			return err
		}

		entryID, ok := attrString(out.Attributes, "entryID")
		if !ok {
			continue // pre-existing item from before entryID was recorded; nothing to clean up
		}
		if _, err := s.client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
			TableName: aws.String(s.tableName),
			Key: map[string]types.AttributeValue{
				pkAttr: &types.AttributeValueMemberS{Value: circleLogID},
				skAttr: &types.AttributeValueMemberS{Value: idemSK(entryID)},
			},
		}); err != nil {
			return err
		}
	}

	_, err = s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			pkAttr: &types.AttributeValueMemberS{Value: circleLogID},
			skAttr: &types.AttributeValueMemberS{Value: counterSK},
		},
		UpdateExpression: aws.String("SET oldestAvailableEpoch = :newOldest"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":newOldest": &types.AttributeValueMemberN{Value: strconv.FormatInt(cutoff+1, 10)},
		},
	})
	return err
}
