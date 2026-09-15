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

// commit runs the three-item transaction shared by Append, Rotate,
// ChangeAuthority and DeleteCircle: the caller-supplied conditional update
// to #control (a counter bump, plus whichever discretionary field the
// caller is changing), the entry Put, and the idempotency marker Put.
// Returns the raw TransactWriteItems error unexamined — callers use
// convergeOnRace to interpret it.
//
// authorIdentityPublicKey is omitted from the entry item entirely when
// empty (Rotate/ChangeAuthority/DeleteCircle always pass "") rather than
// stored as an empty string — same convention as the S3 blob store's
// uploader-metadata field.
func (s *Store) commit(ctx context.Context, syncID string, ns synclog.Namespace, entryID string, encryptedPayload []byte, keyVersion, epoch, receivedAt int64, authorIdentityPublicKey string, controlUpdate types.Update) (synclog.CommitResult, error) {
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

	_, err := s.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Update: &controlUpdate},
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item:      entryItem,
				},
			},
			{
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
		},
	})
	if err != nil {
		return synclog.CommitResult{}, err
	}
	return synclog.CommitResult{Epoch: epoch, ReceivedAt: receivedAt}, nil
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
