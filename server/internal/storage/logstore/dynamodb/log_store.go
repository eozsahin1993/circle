// Package dynamodb implements logstore.Store against a single DynamoDB
// table.
package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/storage/dynamoutil"
	"circle-relay/internal/storage/logstore"
)

// DefaultLogRetentionDays is configurable per server/DESIGN.md. Eviction
// itself is DynamoDB's native TTL feature, not application code — this
// value only controls what `expiresAt` gets written as at commit time.
const DefaultLogRetentionDays = 14

// readPageSize caps how many entries a single Read call returns — an
// internal server policy, not a client-controllable parameter. A caller
// that needs more just calls again with `since` advanced to the epoch of
// the last entry it actually received (never to LatestEpoch — a truncated
// page means LatestEpoch is still ahead of what was actually returned).
const readPageSize = 200

// Single-table design: PK = circleLogId, SK distinguishes item kinds.
// Sort keys share one attribute (DynamoDB requires a uniform type per
// table), so epoch is represented as a zero-padded string to preserve
// numeric ordering lexicographically — the standard trick for mixing
// numeric ordering into a string sort key.
const (
	counterSK  = "#counter"
	epochWidth = 12 // supports up to 999,999,999,999 entries per circle — generous past any real use.
)

func epochSK(epoch int64) string {
	return fmt.Sprintf("epoch#%0*d", epochWidth, epoch)
}

// epochSKUpperBound sorts after any real epoch key, for range queries.
func epochSKUpperBound() string {
	max := ""
	for i := 0; i < epochWidth; i++ {
		max += "9"
	}
	return "epoch#" + max
}

func idemSK(entryID string) string {
	return "idem#" + entryID
}

type Store struct {
	client           *dynamodb.Client
	tableName        string
	retentionSeconds int64
}

func New(client *dynamodb.Client, tableName string, logRetentionDays int64) *Store {
	if logRetentionDays <= 0 {
		logRetentionDays = DefaultLogRetentionDays
	}
	return &Store{client: client, tableName: tableName, retentionSeconds: logRetentionDays * 24 * 60 * 60}
}

var _ logstore.Store = (*Store)(nil)

// CommitEntry assigns an epoch, then writes the log entry and the
// idempotency marker in one TransactWriteItems call — both happen or
// neither does. The epoch assignment itself is a separate, non-
// transactional counter bump; if the transaction that follows fails, that
// epoch just goes unused (a harmless gap — same as an entry aging out
// under TTL, from a client's perspective), which is a fine trade for
// keeping "content written" and "idempotency recorded" atomically linked.
//
// Both items carry their own `expiresAt` (epoch seconds) and are deleted
// independently by DynamoDB's TTL sweep once the table's TTL attribute is
// enabled (see provision/modules/storage/dynamodb.tf) — no application
// code deletes anything.
func (s *Store) CommitEntry(ctx context.Context, circleLogID, entryID string, encryptedMeta []byte) (logstore.CommitResult, error) {
	// Consistent read first: a pure retry of an already-committed entryID
	// returns here without ever touching the counter.
	if existing, err := s.lookupIdempotencyMarker(ctx, circleLogID, entryID); err != nil {
		return logstore.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	epoch, err := s.nextEpochAtomically(ctx, circleLogID)
	if err != nil {
		return logstore.CommitResult{}, err
	}
	receivedAt := dynamoutil.NowMillis()
	expiresAt := receivedAt/1000 + s.retentionSeconds

	_, err = s.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item: map[string]types.AttributeValue{
						dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: circleLogID},
						dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: epochSK(epoch)},
						"epoch":           &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
						"encryptedMeta":   &types.AttributeValueMemberB{Value: encryptedMeta},
						"receivedAt":      &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
						"expiresAt":       &types.AttributeValueMemberN{Value: strconv.FormatInt(expiresAt, 10)},
					},
				},
			},
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item: map[string]types.AttributeValue{
						dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: circleLogID},
						dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: idemSK(entryID)},
						"epoch":           &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
						"receivedAt":      &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
						"expiresAt":       &types.AttributeValueMemberN{Value: strconv.FormatInt(expiresAt, 10)},
					},
					ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s)", dynamoutil.PKAttr)),
				},
			},
		},
	})
	if err == nil {
		return logstore.CommitResult{Epoch: epoch, ReceivedAt: receivedAt}, nil
	}

	// Someone else already committed this entryID — look up what they
	// recorded and return that, so a retry converges instead of erroring.
	var canceled *types.TransactionCanceledException
	if errors.As(err, &canceled) {
		if existing, lookupErr := s.lookupIdempotencyMarker(ctx, circleLogID, entryID); lookupErr == nil && existing != nil {
			return *existing, nil
		}
	}
	return logstore.CommitResult{}, err
}

func (s *Store) nextEpochAtomically(ctx context.Context, circleLogID string) (int64, error) {
	out, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: circleLogID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: counterSK},
		},
		UpdateExpression: aws.String("ADD #counter :one"),
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
	return dynamoutil.AttrInt(out.Attributes, "counter")
}

func (s *Store) lookupIdempotencyMarker(ctx context.Context, circleLogID, entryID string) (*logstore.CommitResult, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: circleLogID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: idemSK(entryID)},
		},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	epoch, err := dynamoutil.AttrInt(out.Item, "epoch")
	if err != nil {
		return nil, err
	}
	receivedAt, err := dynamoutil.AttrInt(out.Item, "receivedAt")
	if err != nil {
		return nil, err
	}
	return &logstore.CommitResult{Epoch: epoch, ReceivedAt: receivedAt}, nil
}

func (s *Store) Read(ctx context.Context, circleLogID string, since int64) (logstore.FetchSinceResult, error) {
	counterOut, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: circleLogID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: counterSK},
		},
	})
	if err != nil {
		return logstore.FetchSinceResult{}, err
	}
	if counterOut.Item == nil {
		return logstore.FetchSinceResult{Entries: []logstore.LogEntry{}}, nil
	}
	latestEpoch, err := dynamoutil.AttrInt(counterOut.Item, "counter")
	if err != nil {
		return logstore.FetchSinceResult{}, err
	}

	oldestAvailableEpoch, err := s.oldestAvailableEpoch(ctx, circleLogID)
	if err != nil {
		return logstore.FetchSinceResult{}, err
	}

	lowerBound := since
	if lowerBound < oldestAvailableEpoch-1 {
		lowerBound = oldestAvailableEpoch - 1
	}

	// Loops rather than one Query call: DynamoDB caps a single Query
	// response at 1MB of data regardless of readPageSize, signaling "more
	// exists past this page" via LastEvaluatedKey — a single unpaginated
	// call would silently return a partial result once a circle's backlog
	// since `since` crosses that size, with nothing telling the caller
	// entries were missing. Each iteration asks DynamoDB for only as many
	// items as still needed to reach readPageSize, so this never
	// over-fetches past the intended page size either.
	entries := make([]logstore.LogEntry, 0, readPageSize)
	var exclusiveStartKey map[string]types.AttributeValue
	for len(entries) < readPageSize {
		queryOut, err := s.client.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.tableName),
			KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND %s BETWEEN :lower AND :upper", dynamoutil.PKAttr, dynamoutil.SKAttr)),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk":    &types.AttributeValueMemberS{Value: circleLogID},
				":lower": &types.AttributeValueMemberS{Value: epochSK(lowerBound + 1)},
				":upper": &types.AttributeValueMemberS{Value: epochSKUpperBound()},
			},
			ScanIndexForward:  aws.Bool(true),
			Limit:             aws.Int32(int32(readPageSize - len(entries))),
			ExclusiveStartKey: exclusiveStartKey,
		})
		if err != nil {
			return logstore.FetchSinceResult{}, err
		}

		for _, item := range queryOut.Items {
			epoch, err := dynamoutil.AttrInt(item, "epoch")
			if err != nil {
				return logstore.FetchSinceResult{}, err
			}
			receivedAt, err := dynamoutil.AttrInt(item, "receivedAt")
			if err != nil {
				return logstore.FetchSinceResult{}, err
			}
			blobAttr, ok := item["encryptedMeta"].(*types.AttributeValueMemberB)
			if !ok {
				return logstore.FetchSinceResult{}, fmt.Errorf("entry at epoch %d missing encryptedMeta", epoch)
			}
			entries = append(entries, logstore.LogEntry{Epoch: epoch, EncryptedMeta: blobAttr.Value, ReceivedAt: receivedAt})
		}

		if queryOut.LastEvaluatedKey == nil {
			break
		}
		exclusiveStartKey = queryOut.LastEvaluatedKey
	}
	// No sort needed: ScanIndexForward already returns each page in
	// ascending epoch order, and consecutive pages continue that same
	// order, so entries is already fully sorted by the time this loop ends.

	return logstore.FetchSinceResult{
		Entries:              entries,
		LatestEpoch:          latestEpoch,
		OldestAvailableEpoch: oldestAvailableEpoch,
	}, nil
}

// oldestAvailableEpoch finds the epoch of the oldest log entry that
// currently physically exists for circleLogID — computed live, on every
// read, rather than tracked in bookkeeping the way a manual trim would.
// TTL deletion is best-effort ("typically within 48 hours of expiration"
// per AWS's own docs, not instant), so this can occasionally lag a bit
// behind the true retention cutoff — an item just past its own expiresAt
// but not yet swept still counts as "available" here. That slack is
// small relative to a multi-day/week retention window and is the
// deliberate trade for not running any custom deletion code at all.
//
// This as a single scalar cutoff is only a *complete* gap signal when
// expiresAt is monotonic in epoch — true as long as LOG_RETENTION_DAYS
// stays constant or only increases, since a later entry then always
// expires no earlier than an older one. Decreasing it breaks that: an
// entry written just after the decrease gets the new, shorter window
// immediately, so it can expire before an older entry that's still
// riding out its longer, pre-change expiresAt — a real hole in the
// *middle* of the epoch range, for roughly the length of the old
// retention window, that this single "oldest surviving epoch" value
// won't reflect (a caller past it would look caught up while still
// missing that hole). Not fixed here: nothing downstream reads this yet
// (no client-side pull/catch-up path exists), and it's a rare, deliberate
// operator action, not a routine one. If/when that changes, know this
// before treating LOG_RETENTION_DAYS as freely adjustable in both
// directions.
func (s *Store) oldestAvailableEpoch(ctx context.Context, circleLogID string) (int64, error) {
	out, err := s.client.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.tableName),
		KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND %s BETWEEN :lower AND :upper", dynamoutil.PKAttr, dynamoutil.SKAttr)),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":    &types.AttributeValueMemberS{Value: circleLogID},
			":lower": &types.AttributeValueMemberS{Value: epochSK(1)},
			":upper": &types.AttributeValueMemberS{Value: epochSKUpperBound()},
		},
		ScanIndexForward: aws.Bool(true),
		Limit:            aws.Int32(1),
	})
	if err != nil {
		return 0, err
	}
	if len(out.Items) == 0 {
		return 0, nil // nothing survives (or nothing was ever committed)
	}
	return dynamoutil.AttrInt(out.Items[0], "epoch")
}
