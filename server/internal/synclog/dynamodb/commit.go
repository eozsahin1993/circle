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

// commit runs the transaction shared by every appending operation: the
// caller-supplied conditional update to #control (a counter bump, plus
// whichever discretionary field the caller is changing), any extra items
// the caller needs alongside it (DeleteEntry's payload strip is the only
// one today), the entry Put, and the idempotency marker Put — in that
// order, though TransactWriteItems' all-or-nothing semantics make the
// order irrelevant to correctness. Returns the raw TransactWriteItems
// error unexamined — callers use convergeOnRace to interpret it.
//
// authorIdentityPublicKey is omitted from the entry item entirely when
// empty (Rotate/ChangeAuthority/DeleteCircle always pass "") rather than
// stored as an empty string — same convention as the S3 blob store's
// uploader-metadata field.
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

// casPlan is what one casCommit attempt wants to write, built fresh
// against the control state that attempt actually read.
type casPlan struct {
	// Control is the conditional #control mutation — the counter bump
	// plus whichever discretionary field this operation changes. Its
	// ConditionExpression is what makes the attempt atomic.
	Control types.Update
	// Extra rides in the same transaction as the entry and its
	// idempotency marker. DeleteEntry's payload strip is the only one
	// today.
	Extra []types.TransactWriteItem
}

// casCommit is the read-check-transact-retry loop every appending
// operation shares. Callers do their own upfront idempotency check and
// any one-time setup (a signature check, a GSI lookup) before calling
// this — those don't depend on which attempt eventually wins, so
// repeating them per attempt would be wasted work at best and, for a
// lookup like DeleteEntry's, an extra read on every call rather than
// only on the rare race.
//
// plan runs once per attempt, against the control state that attempt
// just read, and returns what to write conditioned on it. An error from
// plan aborts immediately without retrying — a policy refusal (wrong
// write token, circle deleted, signer not authorized...) is a rejection
// of this request, not a race worth retrying past.
//
// replayed reports that a concurrent identical commit won the race
// (convergeOnRace found its marker) and result is that commit's
// original, not a new one. DeleteCircle needs to know only that plan ran
// at least once (to sweep with the counter it captured), not the
// distinction itself — every other caller ignores it.
func (s *Store) casCommit(
	ctx context.Context,
	syncID string,
	ns synclog.Namespace,
	entryID string,
	entry entryFields,
	plan func(control *controlState, epoch, receivedAt int64) (casPlan, error),
) (result synclog.CommitResult, replayed bool, err error) {
	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		control, err := s.getControlState(ctx, syncID, true)
		if err != nil {
			return synclog.CommitResult{}, false, err
		}

		epoch := control.counter(ns) + 1
		receivedAt := dynamoutil.NowMillis()

		p, err := plan(control, epoch, receivedAt)
		if err != nil {
			return synclog.CommitResult{}, false, err
		}

		result, err := s.commit(ctx, syncID, ns, entryID, entry.EncryptedPayload, entry.KeyVersion, epoch, receivedAt, entry.AuthorIdentityPublicKey, p.Control, p.Extra)
		if err == nil {
			return result, false, nil
		}
		converged, convErr := s.convergeOnRace(ctx, syncID, ns, entryID, err)
		if convErr != nil {
			return synclog.CommitResult{}, false, convErr
		}
		if converged != nil {
			return *converged, true, nil
		}
		// Neither converged nor a hard error: #control moved under us
		// (someone else's concurrent Append/Rotate won the race) — loop
		// and retry against fresh state.
	}
	return synclog.CommitResult{}, false, synclog.ErrConcurrentModification
}

// stripEntryFields is the encryptedMeta-removing, deletedAt/deletedBy-
// stamping mutation shared by DeleteEntry (riding inside its transaction)
// and stripAuthorContent (as a standalone conditional UpdateItem) — same
// row shape, different transports, so this returns the pieces rather than
// either SDK's own request type.
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
