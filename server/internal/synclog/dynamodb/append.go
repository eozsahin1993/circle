package dynamodb

import (
	"context"
	"fmt"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/synclog"
)

// Append verifies possession (the write token) and bumps ns's counter
// atomically, then writes the entry and its idempotency marker in the
// same transaction. See getControlState's doc comment for why this is a
// read-then-compare-and-swap rather than one unconditional transaction.
func (s *Store) Append(ctx context.Context, syncID string, ns synclog.Namespace, entryID string, encryptedPayload []byte, keyVersion int64, writeTokenHash, authorIdentityPublicKey string) (synclog.CommitResult, error) {
	if !ns.Valid() {
		return synclog.CommitResult{}, synclog.ErrInvalidNamespace
	}
	if existing, err := s.lookupIdempotencyMarker(ctx, syncID, ns, entryID); err != nil {
		return synclog.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	result, err := s.casCommit(ctx, syncID, ns, entryID, entryFields{
		EncryptedPayload:        encryptedPayload,
		KeyVersion:              keyVersion,
		AuthorIdentityPublicKey: authorIdentityPublicKey,
	}, func(control *controlState, epoch, receivedAt int64) (casPlan, error) {
		if control.writeTokenHash != writeTokenHash {
			return casPlan{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return casPlan{}, synclog.ErrCircleDeleted
		}

		// attribute_not_exists(deletedAt) as well as the check above: a
		// deletion landing between them bumps metaCounter, which a content
		// append isn't watching, so the counter CAS alone wouldn't catch it.
		counterAttr := counterAttrName(ns)
		return casPlan{Control: types.Update{
			TableName:           aws.String(s.tableName),
			Key:                 controlKey(syncID),
			UpdateExpression:    aws.String(fmt.Sprintf("SET %s = :next", counterAttr)),
			ConditionExpression: aws.String(fmt.Sprintf("writeTokenHash = :hash AND %s = :current AND attribute_not_exists(deletedAt)", counterAttr)),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":hash":    &types.AttributeValueMemberS{Value: writeTokenHash},
				":current": &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch-1, 10)},
				":next":    &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
			},
		}}, nil
	})
	return result, err
}

// Rotate runs the possession-check-and-CAS pattern Append does, plus an
// authority-set membership check, and swaps in the new write-token hash
// in the same transaction as the entry write. See LogStore.Rotate for
// why the signature itself isn't checked here.
func (s *Store) Rotate(ctx context.Context, syncID, entryID string, encryptedPayload []byte, currentKeyVersion int64, currentWriteTokenHash, newWriteTokenHash, authorityPublicKey string) (synclog.CommitResult, error) {
	if existing, err := s.lookupIdempotencyMarker(ctx, syncID, synclog.NamespaceMeta, entryID); err != nil {
		return synclog.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	result, err := s.casCommit(ctx, syncID, synclog.NamespaceMeta, entryID, entryFields{
		EncryptedPayload: encryptedPayload,
		KeyVersion:       currentKeyVersion,
	}, func(control *controlState, epoch, receivedAt int64) (casPlan, error) {
		if control.writeTokenHash != currentWriteTokenHash {
			return casPlan{}, synclog.ErrWriteTokenMismatch
		}
		if control.deleted {
			return casPlan{}, synclog.ErrCircleDeleted
		}
		if !control.authoritySet[authorityPublicKey] {
			return casPlan{}, synclog.ErrAuthorityNotRecognized
		}

		return casPlan{Control: types.Update{
			TableName:           aws.String(s.tableName),
			Key:                 controlKey(syncID),
			UpdateExpression:    aws.String("SET writeTokenHash = :newHash, metaCounter = :next"),
			ConditionExpression: aws.String("writeTokenHash = :currentHash AND metaCounter = :current AND contains(authoritySet, :pubkey) AND attribute_not_exists(deletedAt)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":currentHash": &types.AttributeValueMemberS{Value: currentWriteTokenHash},
				":newHash":     &types.AttributeValueMemberS{Value: newWriteTokenHash},
				":current":     &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch-1, 10)},
				":next":        &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
				":pubkey":      &types.AttributeValueMemberS{Value: authorityPublicKey},
			},
		}}, nil
	})
	return result, err
}

// ChangeAuthority runs the same verify-then-CAS shape as Rotate, over
// authoritySet rather than writeTokenHash. See LogStore.ChangeAuthority
// for why validation and signature verification aren't done here.
func (s *Store) ChangeAuthority(ctx context.Context, syncID, entryID string, encryptedPayload []byte, keyVersion int64, writeTokenHash string, action synclog.AuthorityAction, targetAuthorityPublicKey, signerAuthorityPublicKey string) (synclog.CommitResult, error) {
	if existing, err := s.lookupIdempotencyMarker(ctx, syncID, synclog.NamespaceMeta, entryID); err != nil {
		return synclog.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	setClause := "SET metaCounter = :next "
	condition := "writeTokenHash = :hash AND metaCounter = :current AND contains(authoritySet, :signer) AND attribute_not_exists(deletedAt)"
	values := map[string]types.AttributeValue{}
	if action == synclog.AuthorityAdd {
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
		if action == synclog.AuthorityRemove && len(control.authoritySet) <= 1 {
			return casPlan{}, synclog.ErrWouldEmptyAuthoritySet
		}

		return casPlan{Control: types.Update{
			TableName:                 aws.String(s.tableName),
			Key:                       controlKey(syncID),
			UpdateExpression:          aws.String(setClause),
			ConditionExpression:       aws.String(condition),
			ExpressionAttributeValues: withCASValues(values, writeTokenHash, epoch-1, epoch, signerAuthorityPublicKey, targetAuthorityPublicKey),
		}}, nil
	})
	return result, err
}

// withCASValues fills in the placeholders every ChangeAuthority attempt
// shares, alongside whichever the action added.
func withCASValues(values map[string]types.AttributeValue, writeTokenHash string, current, nextEpoch int64, signerAuthorityPublicKey, targetAuthorityPublicKey string) map[string]types.AttributeValue {
	merged := map[string]types.AttributeValue{
		":hash":    &types.AttributeValueMemberS{Value: writeTokenHash},
		":current": &types.AttributeValueMemberN{Value: strconv.FormatInt(current, 10)},
		":next":    &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
		":signer":  &types.AttributeValueMemberS{Value: signerAuthorityPublicKey},
		":target":  &types.AttributeValueMemberSS{Value: []string{targetAuthorityPublicKey}},
	}
	for key, value := range values {
		merged[key] = value
	}
	return merged
}
