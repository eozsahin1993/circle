package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/synclog"
	"circle-relay/internal/util/dynamoutil"
)

// DeleteAuthorContent strips every content entry one identity authored —
// see LogStore.DeleteAuthorContent for why signature verification isn't
// done here.
//
// The strip itself carries no control-state CAS: it appends nothing and
// each row mutation is idempotent, so concurrent appends don't need
// fencing out. Only the optional tombstone goes through Append's usual
// gate. Re-running after a partial failure converges — stripped rows no
// longer match the query's attribute_exists(encryptedMeta) filter.
func (s *Store) DeleteAuthorContent(ctx context.Context, syncID, authorIdentityPublicKey, tombstoneEntryID string, encryptedPayload []byte, keyVersion int64, writeTokenHash string) (synclog.AuthorContentResult, error) {
	withTombstone := tombstoneEntryID != ""
	if withTombstone {
		// Checked before the strip so a stale token fails the whole call
		// up front rather than after rows are already gone. Append below
		// re-checks it atomically.
		control, err := s.getControlState(ctx, syncID, false)
		if err != nil {
			return synclog.AuthorContentResult{}, err
		}
		if control.writeTokenHash != writeTokenHash {
			return synclog.AuthorContentResult{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return synclog.AuthorContentResult{}, synclog.ErrCircleDeleted
		}
	} else if _, err := s.getControlState(ctx, syncID, false); err != nil {
		return synclog.AuthorContentResult{}, err
	}

	stripped, err := s.stripAuthorContent(ctx, syncID, authorIdentityPublicKey)
	if err != nil {
		return synclog.AuthorContentResult{}, err
	}

	result := synclog.AuthorContentResult{StrippedEntryIDs: stripped}
	if withTombstone {
		commit, err := s.Append(ctx, syncID, synclog.NamespaceMeta, tombstoneEntryID, encryptedPayload, keyVersion, writeTokenHash, authorIdentityPublicKey)
		if err != nil {
			return synclog.AuthorContentResult{}, err
		}
		result.CommitResult = commit
	}
	return result, nil
}

// stripAuthorContent pages the circle's content range for every row
// authored by authorKey — stripped already or not — and (re-)strips
// each. The same mutation DeleteEntry makes, minus its tombstone; safe to
// re-run on an already-stripped row, since the update's own condition
// only checks the row still exists, not that it still carries ciphertext.
//
// Deliberately not filtered to rows that still carry ciphertext: the
// caller needs every authored entryId back to clean up blobs, including
// ones stripped by an earlier call whose tombstone Append then failed —
// filtering them out here would silently drop those blobs from cleanup
// forever, since a retry would never see them again. The tombstone
// itself (meta-namespace) is never a candidate regardless: it lives
// outside the content SK range this pages.
//
// Individually conditioned UpdateItems rather than a transaction: an
// unconditioned Update on a row a concurrent circle-deletion sweep just
// removed would resurrect it as a ghost item, and one condition failure
// inside TransactWriteItems would abort rows that did nothing wrong.
// Bounded fan-out, same reasoning as sweepConcurrency.
func (s *Store) stripAuthorContent(ctx context.Context, syncID, authorKey string) ([]string, error) {
	type target struct{ sk, entryID string }
	var targets []target

	paginator := dynamodb.NewQueryPaginator(s.client, &dynamodb.QueryInput{
		TableName:              aws.String(s.tableName),
		KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND %s BETWEEN :lower AND :upper", dynamoutil.PKAttr, dynamoutil.SKAttr)),
		FilterExpression:       aws.String("authorIdentityPublicKey = :author"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":pk":     &types.AttributeValueMemberS{Value: syncID},
			":lower":  &types.AttributeValueMemberS{Value: entrySK(synclog.NamespaceContent, 1)},
			":upper":  &types.AttributeValueMemberS{Value: entrySKUpperBound(synclog.NamespaceContent)},
			":author": &types.AttributeValueMemberS{Value: authorKey},
		},
		ProjectionExpression: aws.String(fmt.Sprintf("%s, entryId", dynamoutil.SKAttr)),
		ConsistentRead:       aws.Bool(true),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, item := range page.Items {
			sk, _ := dynamoutil.AttrString(item, dynamoutil.SKAttr)
			entryID, _ := dynamoutil.AttrString(item, "entryId")
			targets = append(targets, target{sk: sk, entryID: entryID})
		}
	}

	deletedAt := dynamoutil.NowMillis()
	var wg sync.WaitGroup
	errs := make(chan error, len(targets))
	sem := make(chan struct{}, sweepConcurrency)
	for _, t := range targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(sk string) {
			defer wg.Done()
			defer func() { <-sem }()
			key, updateExpression, values := stripEntryFields(syncID, sk, deletedAt, authorKey)
			_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
				TableName:                 aws.String(s.tableName),
				Key:                       key,
				UpdateExpression:          updateExpression,
				ConditionExpression:       aws.String(fmt.Sprintf("attribute_exists(%s)", dynamoutil.PKAttr)),
				ExpressionAttributeValues: values,
			})
			var conditionFailed *types.ConditionalCheckFailedException
			if err != nil && !errors.As(err, &conditionFailed) {
				errs <- err
			}
		}(t.sk)
	}
	wg.Wait()
	close(errs)
	if err := <-errs; err != nil {
		return nil, err
	}

	entryIDs := make([]string, 0, len(targets))
	for _, t := range targets {
		entryIDs = append(entryIDs, t.entryID)
	}
	return entryIDs, nil
}
