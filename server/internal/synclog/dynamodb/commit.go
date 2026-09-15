package dynamodb

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/dynamoutil"
	"circle-relay/internal/synclog"
)

// commit runs the shared transaction: the conditional #control update,
// any extra items (DeleteEntry's strip), the entry Put, and the
// idempotency marker Put. Returns the raw error; convergeOnRace interprets it.
//
// authorIdentityPublicKey is omitted from the item when empty, not
// stored as "" — same convention as the S3 blob store's uploader field.
func (s *Store) commit(ctx context.Context, syncID string, ns synclog.Namespace, entryID string, encryptedPayload []byte, keyVersion, epoch, receivedAt int64, authorIdentityPublicKey string, controlUpdate types.Update, extra []types.TransactWriteItem) (synclog.CommitResult, error) {
	entryItem := map[string]types.AttributeValue{
		dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
		dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: entrySK(ns, epoch)},
		"epoch":           &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
		"keyVersion":      &types.AttributeValueMemberN{Value: strconv.FormatInt(keyVersion, 10)},
		"encryptedMeta":   &types.AttributeValueMemberB{Value: encryptedPayload},
		"receivedAt":      &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
		"entryId":         &types.AttributeValueMemberS{Value: entryID},
	}
	if authorIdentityPublicKey != "" {
		entryItem["authorIdentityPublicKey"] = &types.AttributeValueMemberS{Value: authorIdentityPublicKey}
	}

	items := make([]types.TransactWriteItem, 0, 3+len(extra))
	items = append(items, types.TransactWriteItem{Update: &controlUpdate})
	items = append(items, extra...)
	items = append(items,
		types.TransactWriteItem{
			Put: &types.Put{
				TableName: aws.String(s.tableName),
				Item:      entryItem,
			},
		},
		types.TransactWriteItem{
			Put: &types.Put{
				TableName: aws.String(s.tableName),
				Item: map[string]types.AttributeValue{
					dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
					dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: idemSK(ns, entryID)},
					"epoch":           &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
					"receivedAt":      &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
					"expiresAt":       &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt/1000+int64(idemMarkerTTL.Seconds()), 10)},
				},
				ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s)", dynamoutil.PKAttr)),
			},
		},
	)

	_, err := s.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
	if err != nil {
		return synclog.CommitResult{}, err
	}
	return synclog.CommitResult{Epoch: epoch, ReceivedAt: receivedAt}, nil
}

// entryFields is the entry half of a commit — everything about the row
// that doesn't depend on which epoch the CAS attempt ends up assigning.
type entryFields struct {
	EncryptedPayload        []byte
	KeyVersion              int64
	AuthorIdentityPublicKey string
}

// casPlan is what one casCommit attempt wants to write.
type casPlan struct {
	// Control is the conditional #control mutation.
	Control types.Update
	// Extra rides in the same transaction. DeleteEntry's strip is the
	// only user today.
	Extra []types.TransactWriteItem
}

// casCommit is the read-check-transact-retry loop every appending
// operation shares. Do one-time setup (signature checks, lookups)
// before calling this, not inside plan — plan reruns per attempt.
//
// plan runs once per attempt against that attempt's control read. An
// error from plan aborts without retrying — a policy refusal, not a
// race worth retrying past.
func (s *Store) casCommit(
	ctx context.Context,
	syncID string,
	ns synclog.Namespace,
	entryID string,
	entry entryFields,
	plan func(control *controlState, epoch, receivedAt int64) (casPlan, error),
) (synclog.CommitResult, error) {
	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		control, err := s.getControlState(ctx, syncID, true)
		if err != nil {
			return synclog.CommitResult{}, err
		}

		epoch := control.counter(ns) + 1
		receivedAt := dynamoutil.NowMillis()

		p, err := plan(control, epoch, receivedAt)
		if err != nil {
			return synclog.CommitResult{}, err
		}

		result, err := s.commit(ctx, syncID, ns, entryID, entry.EncryptedPayload, entry.KeyVersion, epoch, receivedAt, entry.AuthorIdentityPublicKey, p.Control, p.Extra)
		if err == nil {
			return result, nil
		}
		converged, convErr := s.convergeOnRace(ctx, syncID, ns, entryID, err)
		if convErr != nil {
			return synclog.CommitResult{}, convErr
		}
		if converged != nil {
			return *converged, nil
		}
		// Neither converged nor a hard error: #control moved under us
		// (someone else's concurrent Append/Rotate won the race) — loop
		// and retry against fresh state.
	}
	return synclog.CommitResult{}, synclog.ErrConcurrentModification
}

// stripEntryFields is the strip mutation DeleteEntry and
// stripAuthorContent share — returns the pieces since they ride in
// different SDK request types (transaction item vs standalone UpdateItem).
func stripEntryFields(syncID, sk string, deletedAt int64, deletedBy string) (key map[string]types.AttributeValue, updateExpression *string, values map[string]types.AttributeValue) {
	return map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: sk},
		},
		aws.String("REMOVE encryptedMeta SET deletedAt = :t, deletedBy = :who"),
		map[string]types.AttributeValue{
			":t":   &types.AttributeValueMemberN{Value: strconv.FormatInt(deletedAt, 10)},
			":who": &types.AttributeValueMemberS{Value: deletedBy},
		}
}

// convergeOnRace interprets a TransactWriteItems failure from commit: if
// it's not a cancellation, it's a hard error. If it is, either the
// idempotency marker condition lost (someone else's concurrent identical
// commit already won — return their result so both callers converge) or
// the #control condition lost (concurrent state change — return
// (nil, nil) so the caller's retry loop tries again against fresh state).
func (s *Store) convergeOnRace(ctx context.Context, syncID string, ns synclog.Namespace, entryID string, commitErr error) (*synclog.CommitResult, error) {
	var canceled *types.TransactionCanceledException
	if !errors.As(commitErr, &canceled) {
		return nil, commitErr
	}
	existing, err := s.lookupIdempotencyMarker(ctx, syncID, ns, entryID)
	if err != nil {
		return nil, err
	}
	return existing, nil
}

func (s *Store) lookupIdempotencyMarker(ctx context.Context, syncID string, ns synclog.Namespace, entryID string) (*synclog.CommitResult, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.tableName),
		Key: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: idemSK(ns, entryID)},
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
	return &synclog.CommitResult{Epoch: epoch, ReceivedAt: receivedAt}, nil
}
