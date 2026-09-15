package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/dynamoutil"
	"circle-relay/internal/synclog"
)

// DeleteAuthorContent strips every content entry one identity authored —
// see synclog.LogStore.DeleteAuthorContent.
//
// The strip itself carries no control-state CAS: it appends nothing and
// each row mutation is idempotent, so concurrent appends don't need
// fencing out. Only the optional tombstone goes through Append's usual
// gate. Re-running after a partial failure converges — stripped rows no
// longer match the query's attribute_exists(encryptedMeta) filter.
func (s *Store) DeleteAuthorContent(ctx context.Context, deletion synclog.AuthorContentDeletion) (synclog.AuthorContentResult, error) {
	// A failed signature here is a refused credential, not a malformed
	// request — it's the only thing authorizing the strip.
	if err := verifyAuthoritySignature(deletion.AuthorIdentityPublicKey, deletion.Message(), deletion.AuthorSignature); err != nil {
		if errors.Is(err, synclog.ErrInvalidSignature) {
			return synclog.AuthorContentResult{}, synclog.ErrEntryNotAuthorized
		}
		return synclog.AuthorContentResult{}, err
	}

	withTombstone := deletion.TombstoneEntryID != ""
	if withTombstone {
		// Checked before the strip so a stale token fails the whole call
		// up front rather than after rows are already gone. Append below
		// re-checks it atomically.
		if err := s.VerifyWriteToken(ctx, deletion.SyncID, deletion.WriteToken); err != nil {
			return synclog.AuthorContentResult{}, err
		}
	} else if _, err := s.getControlState(ctx, deletion.SyncID, false); err != nil {
		return synclog.AuthorContentResult{}, err
	}

	stripped, err := s.stripAuthorContent(ctx, deletion.SyncID, deletion.AuthorIdentityPublicKey)
	if err != nil {
		return synclog.AuthorContentResult{}, err
	}

	result := synclog.AuthorContentResult{StrippedEntryIDs: stripped}
	if withTombstone {
		commit, err := s.Append(ctx, deletion.SyncID, synclog.NamespaceMeta, deletion.TombstoneEntryID, deletion.EncryptedPayload, deletion.KeyVersion, deletion.WriteToken, deletion.AuthorIdentityPublicKey)
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
			_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
				TableName:           aws.String(s.tableName),
				Key:                 map[string]types.AttributeValue{dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID}, dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: sk}},
				UpdateExpression:    aws.String("REMOVE encryptedMeta SET deletedAt = :t, deletedBy = :who"),
				ConditionExpression: aws.String(fmt.Sprintf("attribute_exists(%s)", dynamoutil.PKAttr)),
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":t":   &types.AttributeValueMemberN{Value: strconv.FormatInt(deletedAt, 10)},
					":who": &types.AttributeValueMemberS{Value: authorKey},
				},
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
