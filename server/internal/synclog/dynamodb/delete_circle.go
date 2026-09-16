package dynamodb

import (
	"context"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"mimoza-relay/internal/synclog"
	"mimoza-relay/internal/util/dynamoutil"
)

// DeleteCircle runs the same verify-then-CAS shape as ChangeAuthority,
// stamping deletedAt instead of touching the authority set, then sweeps
// the content namespace once the tombstone is safely down. See
// LogStore.DeleteCircle for why signature verification isn't done here.
func (s *Store) DeleteCircle(ctx context.Context, syncID, entryID string, encryptedPayload []byte, keyVersion int64, writeTokenHash string, signerAuthorityPublicKey string) (synclog.CommitResult, error) {
	if existing, err := s.lookupIdempotencyMarker(ctx, syncID, synclog.NamespaceMeta, entryID); err != nil {
		return synclog.CommitResult{}, err
	} else if existing != nil {
		// The tombstone is already down, but the sweep behind it may have
		// died partway. Re-running it is what makes the whole operation
		// safe to retry — and it needs the counter the sweep addresses by,
		// which on this path hasn't been read yet.
		control, err := s.getControlState(ctx, syncID, true)
		if err != nil {
			return synclog.CommitResult{}, err
		}
		return *existing, s.sweepDeleted(ctx, syncID, control.contentCounter)
	}

	// Captured by plan on whichever attempt actually commits (or converges
	// on someone else's), so the sweep below always has a real counter —
	// plan runs at least once before casCommit can return without error.
	var sweepCounter int64

	result, err := s.casCommit(ctx, syncID, synclog.NamespaceMeta, entryID, entryFields{
		EncryptedPayload: encryptedPayload,
		KeyVersion:       keyVersion,
	}, func(control *controlState, epoch, receivedAt int64) (casPlan, error) {
		if control.writeTokenHash != writeTokenHash {
			return casPlan{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return casPlan{}, synclog.ErrCircleDeleted
		}
		if !control.authoritySet[signerAuthorityPublicKey] {
			return casPlan{}, synclog.ErrAuthorityNotRecognized
		}

		sweepCounter = control.contentCounter

		return casPlan{Control: types.Update{
			TableName:           aws.String(s.tableName),
			Key:                 controlKey(syncID),
			UpdateExpression:    aws.String("SET metaCounter = :next, deletedAt = :deletedAt"),
			ConditionExpression: aws.String("writeTokenHash = :hash AND metaCounter = :current AND contains(authoritySet, :signer) AND attribute_not_exists(deletedAt)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":hash":      &types.AttributeValueMemberS{Value: writeTokenHash},
				":current":   &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch-1, 10)},
				":next":      &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
				":signer":    &types.AttributeValueMemberS{Value: signerAuthorityPublicKey},
				":deletedAt": &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
			},
		}}, nil
	})
	if err != nil {
		return synclog.CommitResult{}, err
	}
	return result, s.sweepDeleted(ctx, syncID, sweepCounter)
}

// deletedMetaTTL is how long a deleted circle's meta namespace outlives
// the deletion. Content goes at once; meta lingers for a device restored
// by transfer, which starts at cursor zero carrying no roster and rebuilds
// one from these entries — without them it has nothing to verify the
// tombstone against, so it would skip it and keep the circle forever.
//
// Generous on purpose: it only has to outlast a transferred device sitting
// unopened, and costs a few KB per dead circle. Nothing observable happens
// when it fires.
const deletedMetaTTL = 90 * 24 * time.Hour

// sweepDeleted clears out a circle that has just been tombstoned: content
// goes now, meta goes on a timer.
//
// Safe to run repeatedly, which is what makes the whole deletion
// resumable — a run that dies partway (the sweep is bounded by a 10s
// Lambda, and a large circle can outlast it) leaves everything it already
// removed removed, so the next attempt picks up from there rather than
// starting over.
func (s *Store) sweepDeleted(ctx context.Context, syncID string, contentCounter int64) error {
	// Nothing but this sweep ever deletes an entry, so a counter still at
	// zero means the circle never had content at all. The common case for
	// one deleted by its last member, which may well be a circle nobody
	// ever posted to.
	if contentCounter > 0 {
		if err := s.sweepContent(ctx, syncID, contentCounter); err != nil {
			return err
		}
	}
	return s.expireMeta(ctx, syncID)
}

// expireMeta hands the meta namespace to DynamoDB's TTL rather than
// deleting it — see deletedMetaTTL for why it outlives the deletion at
// all. Stamped rather than swept because these entries still have a job
// to do; TTL is simply the cheapest way to stop paying for them once they
// don't.
//
// The tombstone is stamped along with everything else. It has already
// been delivered to anything that could still act on it by the time this
// fires.
func (s *Store) expireMeta(ctx context.Context, syncID string) error {
	expiresAt := dynamoutil.NowMillis()/1000 + int64(deletedMetaTTL.Seconds())
	paginator := dynamodb.NewQueryPaginator(s.client, &dynamodb.QueryInput{
		TableName:              aws.String(s.tableName),
		KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND %s BETWEEN :lower AND :upper", dynamoutil.PKAttr, dynamoutil.SKAttr)),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":    &types.AttributeValueMemberS{Value: syncID},
			":lower": &types.AttributeValueMemberS{Value: entrySK(synclog.NamespaceMeta, 1)},
			":upper": &types.AttributeValueMemberS{Value: entrySKUpperBound(synclog.NamespaceMeta)},
		},
		ProjectionExpression: aws.String(fmt.Sprintf("%s, %s", dynamoutil.PKAttr, dynamoutil.SKAttr)),
	})

	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return err
		}
		for _, item := range page.Items {
			if _, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
				TableName:                 aws.String(s.tableName),
				Key:                       map[string]types.AttributeValue{dynamoutil.PKAttr: item[dynamoutil.PKAttr], dynamoutil.SKAttr: item[dynamoutil.SKAttr]},
				UpdateExpression:          aws.String("SET expiresAt = :expiresAt"),
				ExpressionAttributeValues: map[string]types.AttributeValue{":expiresAt": &types.AttributeValueMemberN{Value: strconv.FormatInt(expiresAt, 10)}},
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

// sweepContent deletes every content-namespace entry for a circle,
// addressing them by epoch rather than querying for them first.
//
// contentCounter is the highest epoch ever assigned, and the counter bump
// rides in the same transaction as the entry it numbers — so a failed
// write leaves no gap, and epochs 1..contentCounter are exactly the rows
// that exist. That makes the keys computable, which drops the Query
// entirely and lets the whole range fan out at once instead of a page at
// a time.
//
// The cost is that a retry re-issues deletes for rows already gone,
// paying write capacity for no-ops. That only bites when an earlier
// attempt died partway, which is rare, and the sweep still converges.
//
// Idempotency markers are left alone: they expire on their own TTL, and
// removing them early would let a retry of an already-committed entry be
// treated as new. Only entries are swept.
func (s *Store) sweepContent(ctx context.Context, syncID string, contentCounter int64) error {
	var wg sync.WaitGroup
	errs := make(chan error, (contentCounter/batchWriteSize)+1)
	sem := make(chan struct{}, sweepConcurrency)

	for first := int64(1); first <= contentCounter; first += batchWriteSize {
		last := min(first+batchWriteSize-1, contentCounter)
		requests := make([]types.WriteRequest, 0, last-first+1)
		for epoch := first; epoch <= last; epoch++ {
			requests = append(requests, types.WriteRequest{DeleteRequest: &types.DeleteRequest{
				Key: map[string]types.AttributeValue{
					dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
					dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: entrySK(synclog.NamespaceContent, epoch)},
				},
			}})
		}

		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			if err := s.batchDelete(ctx, requests); err != nil {
				errs <- err
			}
		}()
	}

	wg.Wait()
	close(errs)
	// One failure is enough to stop: the caller retries the whole sweep,
	// and whatever these goroutines did delete stays deleted.
	return <-errs
}

// batchDelete writes one BatchWriteItem and keeps resubmitting whatever
// DynamoDB hands back as unprocessed — a throttled batch reports the
// items it skipped in the response rather than as an error, so ignoring
// UnprocessedItems would silently leave entries behind. Same backoff as
// Peek's UnprocessedKeys loop, and for the same reason: retrying
// immediately adds load to a table already pushing back.
func (s *Store) batchDelete(ctx context.Context, requests []types.WriteRequest) error {
	pending := map[string][]types.WriteRequest{s.tableName: requests}
	for attempt := 0; len(pending) > 0; attempt++ {
		if attempt > 0 {
			if err := sleepBackoff(ctx, attempt); err != nil {
				return err
			}
		}
		out, err := s.client.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{RequestItems: pending})
		if err != nil {
			return err
		}
		pending = out.UnprocessedItems
	}
	return nil
}
