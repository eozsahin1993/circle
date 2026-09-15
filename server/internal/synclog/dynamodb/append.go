package dynamodb

import (
	"context"
	"fmt"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/dynamoutil"
	"circle-relay/internal/synclog"
)

// Append verifies possession (the write token) and bumps ns's counter
// atomically, then writes the entry and its idempotency marker in the
// same transaction. See getControlState's doc comment for why this is a
// read-then-compare-and-swap rather than one unconditional transaction.
func (s *Store) Append(ctx context.Context, syncID string, ns synclog.Namespace, entryID string, encryptedPayload []byte, keyVersion int64, writeToken, authorIdentityPublicKey string) (synclog.CommitResult, error) {
	if !ns.Valid() {
		return synclog.CommitResult{}, synclog.ErrInvalidNamespace
	}
	if existing, err := s.lookupIdempotencyMarker(ctx, syncID, ns, entryID); err != nil {
		return synclog.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	// A malformed (non-hex) token can never be correct, so it fails the
	// same way a well-formed-but-wrong one does — one outcome, not two,
	// for "this token doesn't work."
	expectedHash, hashErr := hashWriteToken(writeToken)

	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		control, err := s.getControlState(ctx, syncID, true)
		if err != nil {
			return synclog.CommitResult{}, err
		}
		if hashErr != nil || control.writeTokenHash != expectedHash {
			return synclog.CommitResult{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return synclog.CommitResult{}, synclog.ErrCircleDeleted
		}

		current := control.counter(ns)
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		// attribute_not_exists(deletedAt) as well as the check above: a
		// deletion landing between them bumps metaCounter, which a content
		// append isn't watching, so the counter CAS alone wouldn't catch it.
		counterAttr := counterAttrName(ns)
		result, err := s.commit(ctx, syncID, ns, entryID, encryptedPayload, keyVersion, nextEpoch, receivedAt, authorIdentityPublicKey, types.Update{
			TableName:           aws.String(s.tableName),
			Key:                 controlKey(syncID),
			UpdateExpression:    aws.String(fmt.Sprintf("SET %s = :next", counterAttr)),
			ConditionExpression: aws.String(fmt.Sprintf("writeTokenHash = :hash AND %s = :current AND attribute_not_exists(deletedAt)", counterAttr)),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":hash":    &types.AttributeValueMemberS{Value: expectedHash},
				":current": &types.AttributeValueMemberN{Value: strconv.FormatInt(current, 10)},
				":next":    &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
			},
		})
		if err == nil {
			return result, nil
		}
		if converged, convErr := s.convergeOnRace(ctx, syncID, ns, entryID, err); convErr != nil {
			return synclog.CommitResult{}, convErr
		} else if converged != nil {
			return *converged, nil
		}
		// Neither converged nor a hard error: #control moved under us
		// (someone else's concurrent Append/Rotate won the race) — loop
		// and retry against fresh state.
	}
	return synclog.CommitResult{}, synclog.ErrConcurrentModification
}

// Rotate verifies the authority signature before touching storage at all
// — a forged signature must never attempt a mutation — then runs the
// same possession-check-and-CAS pattern as Append, plus an authority-set
// membership check, and swaps in the new write-token hash in the same
// transaction as the entry write.
func (s *Store) Rotate(ctx context.Context, syncID, entryID string, encryptedPayload []byte, currentKeyVersion int64, currentWriteToken, newWriteTokenHash, authorityPublicKey string, signature []byte) (synclog.CommitResult, error) {
	if err := verifyAuthoritySignature(authorityPublicKey, synclog.RotateMessage(syncID, entryID, newWriteTokenHash), signature); err != nil {
		return synclog.CommitResult{}, err
	}

	if existing, err := s.lookupIdempotencyMarker(ctx, syncID, synclog.NamespaceMeta, entryID); err != nil {
		return synclog.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	// Same reasoning as Append: a malformed token can never be correct, so
	// it fails the same way a well-formed-but-wrong one does.
	expectedCurrentHash, hashErr := hashWriteToken(currentWriteToken)

	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		control, err := s.getControlState(ctx, syncID, true)
		if err != nil {
			return synclog.CommitResult{}, err
		}
		if hashErr != nil || control.writeTokenHash != expectedCurrentHash {
			return synclog.CommitResult{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return synclog.CommitResult{}, synclog.ErrCircleDeleted
		}
		if !control.authoritySet[authorityPublicKey] {
			return synclog.CommitResult{}, synclog.ErrAuthorityNotRecognized
		}

		current := control.metaCounter
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		result, err := s.commit(ctx, syncID, synclog.NamespaceMeta, entryID, encryptedPayload, currentKeyVersion, nextEpoch, receivedAt, "", types.Update{
			TableName:           aws.String(s.tableName),
			Key:                 controlKey(syncID),
			UpdateExpression:    aws.String("SET writeTokenHash = :newHash, metaCounter = :next"),
			ConditionExpression: aws.String("writeTokenHash = :currentHash AND metaCounter = :current AND contains(authoritySet, :pubkey) AND attribute_not_exists(deletedAt)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":currentHash": &types.AttributeValueMemberS{Value: expectedCurrentHash},
				":newHash":     &types.AttributeValueMemberS{Value: newWriteTokenHash},
				":current":     &types.AttributeValueMemberN{Value: strconv.FormatInt(current, 10)},
				":next":        &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
				":pubkey":      &types.AttributeValueMemberS{Value: authorityPublicKey},
			},
		})
		if err == nil {
			return result, nil
		}
		if converged, convErr := s.convergeOnRace(ctx, syncID, synclog.NamespaceMeta, entryID, err); convErr != nil {
			return synclog.CommitResult{}, convErr
		} else if converged != nil {
			return *converged, nil
		}
	}
	return synclog.CommitResult{}, synclog.ErrConcurrentModification
}

// ChangeAuthority runs the same verify-then-CAS shape as Rotate, over
// authoritySet rather than writeTokenHash.
func (s *Store) ChangeAuthority(ctx context.Context, change synclog.AuthorityChange) (synclog.CommitResult, error) {
	if !change.Action.Valid() {
		return synclog.CommitResult{}, synclog.ErrInvalidAuthorityAction
	}
	if !validAuthorityKeyHex(change.TargetAuthorityPublicKey) {
		return synclog.CommitResult{}, synclog.ErrInvalidAuthorityKey
	}
	if err := verifyAuthoritySignature(change.SignerAuthorityPublicKey, change.Message(), change.Signature); err != nil {
		return synclog.CommitResult{}, err
	}

	if existing, err := s.lookupIdempotencyMarker(ctx, change.SyncID, synclog.NamespaceMeta, change.EntryID); err != nil {
		return synclog.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	expectedHash, hashErr := hashWriteToken(change.WriteToken)

	setClause := "SET metaCounter = :next "
	condition := "writeTokenHash = :hash AND metaCounter = :current AND contains(authoritySet, :signer) AND attribute_not_exists(deletedAt)"
	values := map[string]types.AttributeValue{}
	if change.Action == synclog.AuthorityAdd {
		setClause += "ADD authoritySet :target"
	} else {
		setClause += "DELETE authoritySet :target"
		// Removing the last key would strand the circle, and DynamoDB
		// drops the attribute entirely at zero elements, leaving nothing
		// to add one back to. Self-removal is otherwise legal — that's
		// how leaving hands authority back.
		condition += " AND size(authoritySet) > :one"
		values[":one"] = &types.AttributeValueMemberN{Value: "1"}
	}

	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		control, err := s.getControlState(ctx, change.SyncID, true)
		if err != nil {
			return synclog.CommitResult{}, err
		}
		if hashErr != nil || control.writeTokenHash != expectedHash {
			return synclog.CommitResult{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return synclog.CommitResult{}, synclog.ErrCircleDeleted
		}
		if !control.authoritySet[change.SignerAuthorityPublicKey] {
			return synclog.CommitResult{}, synclog.ErrAuthorityNotRecognized
		}
		if change.Action == synclog.AuthorityRemove && len(control.authoritySet) <= 1 {
			return synclog.CommitResult{}, synclog.ErrWouldEmptyAuthoritySet
		}

		current := control.metaCounter
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		result, err := s.commit(ctx, change.SyncID, synclog.NamespaceMeta, change.EntryID, change.EncryptedPayload, change.KeyVersion, nextEpoch, receivedAt, "", types.Update{
			TableName:                 aws.String(s.tableName),
			Key:                       controlKey(change.SyncID),
			UpdateExpression:          aws.String(setClause),
			ConditionExpression:       aws.String(condition),
			ExpressionAttributeValues: withCASValues(values, expectedHash, current, nextEpoch, change),
		})
		if err == nil {
			return result, nil
		}
		if converged, convErr := s.convergeOnRace(ctx, change.SyncID, synclog.NamespaceMeta, change.EntryID, err); convErr != nil {
			return synclog.CommitResult{}, convErr
		} else if converged != nil {
			return *converged, nil
		}
	}
	return synclog.CommitResult{}, synclog.ErrConcurrentModification
}

// withCASValues fills in the placeholders every ChangeAuthority attempt
// shares, alongside whichever the action added.
func withCASValues(values map[string]types.AttributeValue, expectedHash string, current, nextEpoch int64, change synclog.AuthorityChange) map[string]types.AttributeValue {
	merged := map[string]types.AttributeValue{
		":hash":    &types.AttributeValueMemberS{Value: expectedHash},
		":current": &types.AttributeValueMemberN{Value: strconv.FormatInt(current, 10)},
		":next":    &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
		":signer":  &types.AttributeValueMemberS{Value: change.SignerAuthorityPublicKey},
		":target":  &types.AttributeValueMemberSS{Value: []string{change.TargetAuthorityPublicKey}},
	}
	for key, value := range values {
		merged[key] = value
	}
	return merged
}
