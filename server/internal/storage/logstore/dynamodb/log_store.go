// Package dynamodb implements logstore.Store against a single DynamoDB
// table, one partition per syncID. See internal/storage/logstore's
// package doc for the two capabilities (write token, authority
// signature) this enforces.
package dynamodb

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"circle-relay/internal/storage/dynamoutil"
	"circle-relay/internal/storage/logstore"
)

// readPageSize caps how many entries a single Read call returns — an
// internal server policy, not a client-controllable parameter. A caller
// that needs more just calls again with `since` advanced to the epoch of
// the last entry it actually received (never to CurrentEpoch — a capped
// page means CurrentEpoch is still ahead of what was actually returned).
const readPageSize = 200

// peekRetryBaseDelay/peekRetryMaxDelay bound the backoff between Peek's
// UnprocessedKeys retries — small, because a poll endpoint that stalls is
// worse than one that returns a partial-batch error the client retries on
// its own cadence.
const (
	peekRetryBaseDelay = 20 * time.Millisecond
	peekRetryMaxDelay  = 200 * time.Millisecond
)

// maxCASAttempts bounds the compare-and-swap retry loop Append and Rotate
// use to keep "check the token/authority" and "bump the counter" atomic
// (see getControlState). Retries only happen under genuine concurrent
// writes to the same circle — vanishingly rare at family-circle scale.
const maxCASAttempts = 5

// EntryIDIndexName is the GSI DeleteEntry queries to find a post by id —
// see modules/storage/dynamodb.tf. Exported so internal/localstack can
// create it under the same name in tests.
const EntryIDIndexName = "entryId-index"

// batchWriteSize is DynamoDB's own hard cap on items per BatchWriteItem —
// not a tuning knob. A larger request is rejected outright.
const batchWriteSize = 25

// sweepConcurrency bounds how many delete batches are in flight at once.
// Bounded rather than unlimited because the throughput this buys is the
// same throughput that trips throttling — batchDelete already backs off
// on UnprocessedItems, and a wide fan-out would just spend the budget
// faster and then wait longer.
const sweepConcurrency = 8

// idemMarkerTTL is a short, fixed retry window — deliberately not tied to
// any product retention setting (entries and #control never expire; see
// invariant 1). A marker's only job is making a same-entryID retry
// converge shortly after the original commit.
const idemMarkerTTL = 48 * time.Hour

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

// Single-table design: PK = syncID, SK distinguishes item kinds, epoch
// zero-padded to preserve numeric ordering lexicographically. The four SK
// shapes never collide: "#control" sorts before both namespace prefixes,
// and "idem#<ns>#..." sorts strictly outside either namespace's entry
// range.
const (
	controlSK  = "#control"
	epochWidth = 12 // supports up to 999,999,999,999 entries per namespace — generous past any real use.
)

func entrySK(ns logstore.Namespace, epoch int64) string {
	return fmt.Sprintf("%s#%0*d", ns, epochWidth, epoch)
}

// entrySKUpperBound sorts after any real entry key in ns, for range
// queries.
func entrySKUpperBound(ns logstore.Namespace) string {
	max := ""
	for i := 0; i < epochWidth; i++ {
		max += "9"
	}
	return string(ns) + "#" + max
}

func idemSK(ns logstore.Namespace, entryID string) string {
	return "idem#" + string(ns) + "#" + entryID
}

func counterAttrName(ns logstore.Namespace) string {
	if ns == logstore.NamespaceContent {
		return "contentCounter"
	}
	return "metaCounter"
}

type Store struct {
	client    *dynamodb.Client
	tableName string
}

func New(client *dynamodb.Client, tableName string) *Store {
	return &Store{client: client, tableName: tableName}
}

var _ logstore.Store = (*Store)(nil)

// Bootstrap is a plain conditional PutItem — the founder's own
// member_added entry is a separate, subsequent Append call using the
// write token this registers.
func (s *Store) Bootstrap(ctx context.Context, syncID, founderAuthorityPublicKey, initialWriteTokenHash string) error {
	_, err := s.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.tableName),
		Item: map[string]types.AttributeValue{
			dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
			dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: controlSK},
			"authoritySet":    &types.AttributeValueMemberSS{Value: []string{founderAuthorityPublicKey}},
			"writeTokenHash":  &types.AttributeValueMemberS{Value: initialWriteTokenHash},
			"metaCounter":     &types.AttributeValueMemberN{Value: "0"},
			"contentCounter":  &types.AttributeValueMemberN{Value: "0"},
		},
		ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s)", dynamoutil.PKAttr)),
	})
	if err != nil {
		var condFailed *types.ConditionalCheckFailedException
		if errors.As(err, &condFailed) {
			return logstore.ErrAlreadyExists
		}
		return err
	}
	return nil
}

// Append verifies possession (the write token) and bumps ns's counter
// atomically, then writes the entry and its idempotency marker in the
// same transaction. See getControlState's doc comment for why this is a
// read-then-compare-and-swap rather than one unconditional transaction.
func (s *Store) Append(ctx context.Context, syncID string, ns logstore.Namespace, entryID string, encryptedPayload []byte, keyVersion int64, writeToken, authorIdentityPublicKey string) (logstore.CommitResult, error) {
	if !ns.Valid() {
		return logstore.CommitResult{}, logstore.ErrInvalidNamespace
	}
	if existing, err := s.lookupIdempotencyMarker(ctx, syncID, ns, entryID); err != nil {
		return logstore.CommitResult{}, err
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
			return logstore.CommitResult{}, err
		}
		if hashErr != nil || control.writeTokenHash != expectedHash {
			return logstore.CommitResult{}, logstore.ErrWriteTokenMismatch
		}
		if control.deleted {
			return logstore.CommitResult{}, logstore.ErrCircleDeleted
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
			return logstore.CommitResult{}, convErr
		} else if converged != nil {
			return *converged, nil
		}
		// Neither converged nor a hard error: #control moved under us
		// (someone else's concurrent Append/Rotate won the race) — loop
		// and retry against fresh state.
	}
	return logstore.CommitResult{}, logstore.ErrConcurrentModification
}

// Rotate verifies the authority signature before touching storage at all
// — a forged signature must never attempt a mutation — then runs the
// same possession-check-and-CAS pattern as Append, plus an authority-set
// membership check, and swaps in the new write-token hash in the same
// transaction as the entry write.
func (s *Store) Rotate(ctx context.Context, syncID, entryID string, encryptedPayload []byte, currentKeyVersion int64, currentWriteToken, newWriteTokenHash, authorityPublicKey string, signature []byte) (logstore.CommitResult, error) {
	if err := verifyAuthoritySignature(authorityPublicKey, logstore.RotateMessage(syncID, entryID, newWriteTokenHash), signature); err != nil {
		return logstore.CommitResult{}, err
	}

	if existing, err := s.lookupIdempotencyMarker(ctx, syncID, logstore.NamespaceMeta, entryID); err != nil {
		return logstore.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	// Same reasoning as Append: a malformed token can never be correct, so
	// it fails the same way a well-formed-but-wrong one does.
	expectedCurrentHash, hashErr := hashWriteToken(currentWriteToken)

	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		control, err := s.getControlState(ctx, syncID, true)
		if err != nil {
			return logstore.CommitResult{}, err
		}
		if hashErr != nil || control.writeTokenHash != expectedCurrentHash {
			return logstore.CommitResult{}, logstore.ErrWriteTokenMismatch
		}
		if control.deleted {
			return logstore.CommitResult{}, logstore.ErrCircleDeleted
		}
		if !control.authoritySet[authorityPublicKey] {
			return logstore.CommitResult{}, logstore.ErrAuthorityNotRecognized
		}

		current := control.metaCounter
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		result, err := s.commit(ctx, syncID, logstore.NamespaceMeta, entryID, encryptedPayload, currentKeyVersion, nextEpoch, receivedAt, "", types.Update{
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
		if converged, convErr := s.convergeOnRace(ctx, syncID, logstore.NamespaceMeta, entryID, err); convErr != nil {
			return logstore.CommitResult{}, convErr
		} else if converged != nil {
			return *converged, nil
		}
	}
	return logstore.CommitResult{}, logstore.ErrConcurrentModification
}

// ChangeAuthority runs the same verify-then-CAS shape as Rotate, over
// authoritySet rather than writeTokenHash.
func (s *Store) ChangeAuthority(ctx context.Context, change logstore.AuthorityChange) (logstore.CommitResult, error) {
	if !change.Action.Valid() {
		return logstore.CommitResult{}, logstore.ErrInvalidAuthorityAction
	}
	if !validAuthorityKeyHex(change.TargetAuthorityPublicKey) {
		return logstore.CommitResult{}, logstore.ErrInvalidAuthorityKey
	}
	if err := verifyAuthoritySignature(change.SignerAuthorityPublicKey, change.Message(), change.Signature); err != nil {
		return logstore.CommitResult{}, err
	}

	if existing, err := s.lookupIdempotencyMarker(ctx, change.SyncID, logstore.NamespaceMeta, change.EntryID); err != nil {
		return logstore.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	expectedHash, hashErr := hashWriteToken(change.WriteToken)

	setClause := "SET metaCounter = :next "
	condition := "writeTokenHash = :hash AND metaCounter = :current AND contains(authoritySet, :signer) AND attribute_not_exists(deletedAt)"
	values := map[string]types.AttributeValue{}
	if change.Action == logstore.AuthorityAdd {
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
			return logstore.CommitResult{}, err
		}
		if hashErr != nil || control.writeTokenHash != expectedHash {
			return logstore.CommitResult{}, logstore.ErrWriteTokenMismatch
		}
		if control.deleted {
			return logstore.CommitResult{}, logstore.ErrCircleDeleted
		}
		if !control.authoritySet[change.SignerAuthorityPublicKey] {
			return logstore.CommitResult{}, logstore.ErrAuthorityNotRecognized
		}
		if change.Action == logstore.AuthorityRemove && len(control.authoritySet) <= 1 {
			return logstore.CommitResult{}, logstore.ErrWouldEmptyAuthoritySet
		}

		current := control.metaCounter
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		result, err := s.commit(ctx, change.SyncID, logstore.NamespaceMeta, change.EntryID, change.EncryptedPayload, change.KeyVersion, nextEpoch, receivedAt, "", types.Update{
			TableName:                 aws.String(s.tableName),
			Key:                       controlKey(change.SyncID),
			UpdateExpression:          aws.String(setClause),
			ConditionExpression:       aws.String(condition),
			ExpressionAttributeValues: withCASValues(values, expectedHash, current, nextEpoch, change),
		})
		if err == nil {
			return result, nil
		}
		if converged, convErr := s.convergeOnRace(ctx, change.SyncID, logstore.NamespaceMeta, change.EntryID, err); convErr != nil {
			return logstore.CommitResult{}, convErr
		} else if converged != nil {
			return *converged, nil
		}
	}
	return logstore.CommitResult{}, logstore.ErrConcurrentModification
}

// DeleteCircle runs the same verify-then-CAS shape as ChangeAuthority,
// stamping deletedAt instead of touching the authority set, then sweeps
// the content namespace once the tombstone is safely down.
func (s *Store) DeleteCircle(ctx context.Context, deletion logstore.CircleDeletion) (logstore.CommitResult, error) {
	if err := verifyAuthoritySignature(deletion.SignerAuthorityPublicKey, deletion.Message(), deletion.Signature); err != nil {
		return logstore.CommitResult{}, err
	}

	if existing, err := s.lookupIdempotencyMarker(ctx, deletion.SyncID, logstore.NamespaceMeta, deletion.EntryID); err != nil {
		return logstore.CommitResult{}, err
	} else if existing != nil {
		// The tombstone is already down, but the sweep behind it may have
		// died partway. Re-running it is what makes the whole operation
		// safe to retry — and it needs the counter the sweep addresses by,
		// which on this path hasn't been read yet.
		control, err := s.getControlState(ctx, deletion.SyncID, true)
		if err != nil {
			return logstore.CommitResult{}, err
		}
		return *existing, s.sweepDeleted(ctx, deletion.SyncID, control.contentCounter)
	}

	expectedHash, hashErr := hashWriteToken(deletion.WriteToken)

	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		control, err := s.getControlState(ctx, deletion.SyncID, true)
		if err != nil {
			return logstore.CommitResult{}, err
		}
		if hashErr != nil || control.writeTokenHash != expectedHash {
			return logstore.CommitResult{}, logstore.ErrWriteTokenMismatch
		}
		if control.deleted {
			return logstore.CommitResult{}, logstore.ErrCircleDeleted
		}
		if !control.authoritySet[deletion.SignerAuthorityPublicKey] {
			return logstore.CommitResult{}, logstore.ErrAuthorityNotRecognized
		}

		current := control.metaCounter
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		result, err := s.commit(ctx, deletion.SyncID, logstore.NamespaceMeta, deletion.EntryID, deletion.EncryptedPayload, deletion.KeyVersion, nextEpoch, receivedAt, "", types.Update{
			TableName:           aws.String(s.tableName),
			Key:                 controlKey(deletion.SyncID),
			UpdateExpression:    aws.String("SET metaCounter = :next, deletedAt = :deletedAt"),
			ConditionExpression: aws.String("writeTokenHash = :hash AND metaCounter = :current AND contains(authoritySet, :signer) AND attribute_not_exists(deletedAt)"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":hash":      &types.AttributeValueMemberS{Value: expectedHash},
				":current":   &types.AttributeValueMemberN{Value: strconv.FormatInt(current, 10)},
				":next":      &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
				":signer":    &types.AttributeValueMemberS{Value: deletion.SignerAuthorityPublicKey},
				":deletedAt": &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
			},
		})
		if err == nil {
			return result, s.sweepDeleted(ctx, deletion.SyncID, control.contentCounter)
		}
		if converged, convErr := s.convergeOnRace(ctx, deletion.SyncID, logstore.NamespaceMeta, deletion.EntryID, err); convErr != nil {
			return logstore.CommitResult{}, convErr
		} else if converged != nil {
			return *converged, s.sweepDeleted(ctx, deletion.SyncID, control.contentCounter)
		}
	}
	return logstore.CommitResult{}, logstore.ErrConcurrentModification
}

// findEntryByID resolves a content-namespace entry by id via the
// entryId-index GSI, then fetches the full row from the base table (the
// GSI is KEYS_ONLY). ErrEntryNotFound if absent or in a different circle.
//
// The GSI is only eventually consistent, so a post deleted right after
// being posted can briefly not show up yet — retried with the same
// backoff Peek uses for its own eventually-consistent reads, rather than
// failing a legitimate delete on timing.
func (s *Store) findEntryByID(ctx context.Context, syncID, entryID string) (logstore.LogEntry, error) {
	var queryOut *dynamodb.QueryOutput
	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		if attempt > 0 {
			if err := sleepBackoff(ctx, attempt); err != nil {
				return logstore.LogEntry{}, err
			}
		}
		out, err := s.client.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.tableName),
			IndexName:              aws.String(EntryIDIndexName),
			KeyConditionExpression: aws.String("entryId = :id"),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":id": &types.AttributeValueMemberS{Value: entryID},
			},
			Limit: aws.Int32(1),
		})
		if err != nil {
			return logstore.LogEntry{}, err
		}
		if len(out.Items) > 0 {
			queryOut = out
			break
		}
	}
	if queryOut == nil {
		return logstore.LogEntry{}, logstore.ErrEntryNotFound
	}
	pk, _ := dynamoutil.AttrString(queryOut.Items[0], dynamoutil.PKAttr)
	if pk != syncID {
		return logstore.LogEntry{}, logstore.ErrEntryNotFound
	}
	sk, _ := dynamoutil.AttrString(queryOut.Items[0], dynamoutil.SKAttr)

	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.tableName),
		Key:            map[string]types.AttributeValue{dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: pk}, dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: sk}},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return logstore.LogEntry{}, err
	}
	if out.Item == nil {
		return logstore.LogEntry{}, logstore.ErrEntryNotFound
	}
	epoch, err := dynamoutil.AttrInt(out.Item, "epoch")
	if err != nil {
		return logstore.LogEntry{}, err
	}
	authorIdentityPublicKey, _ := dynamoutil.AttrString(out.Item, "authorIdentityPublicKey")
	return logstore.LogEntry{Epoch: epoch, AuthorIdentityPublicKey: authorIdentityPublicKey}, nil
}

// DeleteEntry strips a post's payload and appends its tombstone — see
// logstore.Store.DeleteEntry.
func (s *Store) DeleteEntry(ctx context.Context, deletion logstore.EntryDeletion) (logstore.CommitResult, error) {
	if existing, err := s.lookupIdempotencyMarker(ctx, deletion.SyncID, logstore.NamespaceContent, deletion.TombstoneEntryID); err != nil {
		return logstore.CommitResult{}, err
	} else if existing != nil {
		return *existing, nil
	}

	post, err := s.findEntryByID(ctx, deletion.SyncID, deletion.TargetEntryID)
	if err != nil {
		return logstore.CommitResult{}, err
	}

	authorizedBy := post.AuthorIdentityPublicKey
	if verifyAuthoritySignature(post.AuthorIdentityPublicKey, deletion.Message(), deletion.AuthorSignature) != nil {
		if deletion.AuthorityPublicKey == "" || len(deletion.AuthoritySignature) == 0 {
			return logstore.CommitResult{}, logstore.ErrEntryNotAuthorized
		}
		if err := s.VerifyAuthoritySignature(ctx, deletion.SyncID, deletion.AuthorityPublicKey, deletion.Message(), deletion.AuthoritySignature); err != nil {
			return logstore.CommitResult{}, err
		}
		authorizedBy = deletion.AuthorityPublicKey
	}

	expectedHash, hashErr := hashWriteToken(deletion.WriteToken)

	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		control, err := s.getControlState(ctx, deletion.SyncID, true)
		if err != nil {
			return logstore.CommitResult{}, err
		}
		if hashErr != nil || control.writeTokenHash != expectedHash {
			return logstore.CommitResult{}, logstore.ErrWriteTokenMismatch
		}
		if control.deleted {
			return logstore.CommitResult{}, logstore.ErrCircleDeleted
		}

		current := control.contentCounter
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		items := []types.TransactWriteItem{
			// 1. Bump the counter — same CAS condition as Append, so a stale
			// or racing write token fails the whole transaction up front.
			{
				Update: &types.Update{
					TableName:           aws.String(s.tableName),
					Key:                 controlKey(deletion.SyncID),
					UpdateExpression:    aws.String("SET contentCounter = :next"),
					ConditionExpression: aws.String("writeTokenHash = :hash AND contentCounter = :current AND attribute_not_exists(deletedAt)"),
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":hash":    &types.AttributeValueMemberS{Value: expectedHash},
						":current": &types.AttributeValueMemberN{Value: strconv.FormatInt(current, 10)},
						":next":    &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
					},
				},
			},
			// 2. Strip the original post.
			{
				Update: &types.Update{
					TableName:        aws.String(s.tableName),
					Key:              map[string]types.AttributeValue{dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: deletion.SyncID}, dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: entrySK(logstore.NamespaceContent, post.Epoch)}},
					UpdateExpression: aws.String("REMOVE encryptedMeta SET deletedAt = :t, deletedBy = :who"),
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":t":   &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
						":who": &types.AttributeValueMemberS{Value: authorizedBy},
					},
				},
			},
			// 3. Append the tombstone, so already-synced devices hide it too.
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item: map[string]types.AttributeValue{
						dynamoutil.PKAttr:         &types.AttributeValueMemberS{Value: deletion.SyncID},
						dynamoutil.SKAttr:         &types.AttributeValueMemberS{Value: entrySK(logstore.NamespaceContent, nextEpoch)},
						"epoch":                   &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
						"keyVersion":              &types.AttributeValueMemberN{Value: strconv.FormatInt(deletion.KeyVersion, 10)},
						"encryptedMeta":           &types.AttributeValueMemberB{Value: deletion.EncryptedPayload},
						"receivedAt":              &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
						"entryId":                 &types.AttributeValueMemberS{Value: deletion.TombstoneEntryID},
						"authorIdentityPublicKey": &types.AttributeValueMemberS{Value: authorizedBy},
					},
				},
			},
			// 4. The tombstone's own idempotency marker, so a retry converges.
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item: map[string]types.AttributeValue{
						dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: deletion.SyncID},
						dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: idemSK(logstore.NamespaceContent, deletion.TombstoneEntryID)},
						"epoch":           &types.AttributeValueMemberN{Value: strconv.FormatInt(nextEpoch, 10)},
						"receivedAt":      &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
						"expiresAt":       &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt/1000+int64(idemMarkerTTL.Seconds()), 10)},
					},
					ConditionExpression: aws.String(fmt.Sprintf("attribute_not_exists(%s)", dynamoutil.PKAttr)),
				},
			},
		}

		_, err = s.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
		if err == nil {
			return logstore.CommitResult{Epoch: nextEpoch, ReceivedAt: receivedAt}, nil
		}
		if converged, convErr := s.convergeOnRace(ctx, deletion.SyncID, logstore.NamespaceContent, deletion.TombstoneEntryID, err); convErr != nil {
			return logstore.CommitResult{}, convErr
		} else if converged != nil {
			return *converged, nil
		}
	}
	return logstore.CommitResult{}, logstore.ErrConcurrentModification
}

// DeleteAuthorContent strips every content entry one identity authored —
// see logstore.Store.DeleteAuthorContent.
//
// The strip itself carries no control-state CAS: it appends nothing and
// each row mutation is idempotent, so concurrent appends don't need
// fencing out. Only the optional tombstone goes through Append's usual
// gate. Re-running after a partial failure converges — stripped rows no
// longer match the query's attribute_exists(encryptedMeta) filter.
func (s *Store) DeleteAuthorContent(ctx context.Context, deletion logstore.AuthorContentDeletion) (logstore.AuthorContentResult, error) {
	// A failed signature here is a refused credential, not a malformed
	// request — it's the only thing authorizing the strip.
	if err := verifyAuthoritySignature(deletion.AuthorIdentityPublicKey, deletion.Message(), deletion.AuthorSignature); err != nil {
		if errors.Is(err, logstore.ErrInvalidSignature) {
			return logstore.AuthorContentResult{}, logstore.ErrEntryNotAuthorized
		}
		return logstore.AuthorContentResult{}, err
	}

	withTombstone := deletion.TombstoneEntryID != ""
	if withTombstone {
		// Checked before the strip so a stale token fails the whole call
		// up front rather than after rows are already gone. Append below
		// re-checks it atomically.
		if err := s.VerifyWriteToken(ctx, deletion.SyncID, deletion.WriteToken); err != nil {
			return logstore.AuthorContentResult{}, err
		}
	} else if _, err := s.getControlState(ctx, deletion.SyncID, false); err != nil {
		return logstore.AuthorContentResult{}, err
	}

	stripped, err := s.stripAuthorContent(ctx, deletion.SyncID, deletion.AuthorIdentityPublicKey)
	if err != nil {
		return logstore.AuthorContentResult{}, err
	}

	result := logstore.AuthorContentResult{StrippedEntryIDs: stripped}
	if withTombstone {
		commit, err := s.Append(ctx, deletion.SyncID, logstore.NamespaceMeta, deletion.TombstoneEntryID, deletion.EncryptedPayload, deletion.KeyVersion, deletion.WriteToken, deletion.AuthorIdentityPublicKey)
		if err != nil {
			return logstore.AuthorContentResult{}, err
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
			":lower":  &types.AttributeValueMemberS{Value: entrySK(logstore.NamespaceContent, 1)},
			":upper":  &types.AttributeValueMemberS{Value: entrySKUpperBound(logstore.NamespaceContent)},
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
			":lower": &types.AttributeValueMemberS{Value: entrySK(logstore.NamespaceMeta, 1)},
			":upper": &types.AttributeValueMemberS{Value: entrySKUpperBound(logstore.NamespaceMeta)},
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
					dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: entrySK(logstore.NamespaceContent, epoch)},
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
func (s *Store) commit(ctx context.Context, syncID string, ns logstore.Namespace, entryID string, encryptedPayload []byte, keyVersion, epoch, receivedAt int64, authorIdentityPublicKey string, controlUpdate types.Update) (logstore.CommitResult, error) {
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
		return logstore.CommitResult{}, err
	}
	return logstore.CommitResult{Epoch: epoch, ReceivedAt: receivedAt}, nil
}

// convergeOnRace interprets a TransactWriteItems failure from commit: if
// it's not a cancellation, it's a hard error. If it is, either the
// idempotency marker condition lost (someone else's concurrent identical
// commit already won — return their result so both callers converge) or
// the #control condition lost (concurrent state change — return
// (nil, nil) so the caller's retry loop tries again against fresh state).
func (s *Store) convergeOnRace(ctx context.Context, syncID string, ns logstore.Namespace, entryID string, commitErr error) (*logstore.CommitResult, error) {
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

func controlKey(syncID string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
		dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: controlSK},
	}
}

type controlState struct {
	authoritySet   map[string]bool
	writeTokenHash string
	metaCounter    int64
	contentCounter int64
	deleted        bool
}

func (c *controlState) counter(ns logstore.Namespace) int64 {
	if ns == logstore.NamespaceContent {
		return c.contentCounter
	}
	return c.metaCounter
}

// getControlState is the read half of the compare-and-swap Append, Rotate
// and ChangeAuthority build on — a separate read because
// TransactWriteItems's Update
// action can't hand back the value it just wrote (only standalone
// UpdateItem supports ReturnValues). So the counter's *next* value is
// computed from a value read beforehand, and the transaction's
// ConditionExpression re-checks nothing moved in between.
func (s *Store) getControlState(ctx context.Context, syncID string, consistent bool) (*controlState, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.tableName),
		Key:            controlKey(syncID),
		ConsistentRead: aws.Bool(consistent),
	})
	if err != nil {
		return nil, err
	}
	if out.Item == nil {
		return nil, logstore.ErrCircleNotFound
	}

	authoritySet := map[string]bool{}
	if attr, ok := out.Item["authoritySet"].(*types.AttributeValueMemberSS); ok {
		for _, key := range attr.Value {
			authoritySet[key] = true
		}
	}
	writeTokenHash, _ := dynamoutil.AttrString(out.Item, "writeTokenHash")
	epochs, err := parseControlEpochs(out.Item)
	if err != nil {
		return nil, err
	}
	_, deleted := out.Item["deletedAt"]
	return &controlState{
		authoritySet:   authoritySet,
		writeTokenHash: writeTokenHash,
		metaCounter:    epochs.Meta,
		contentCounter: epochs.Content,
		deleted:        deleted,
	}, nil
}

// parseControlEpochs reads just the two counters off a #control item —
// shared by getControlState (which also needs the rest of the item) and
// Peek (which needs only this).
func parseControlEpochs(item map[string]types.AttributeValue) (logstore.Epochs, error) {
	metaCounter, err := dynamoutil.AttrInt(item, "metaCounter")
	if err != nil {
		return logstore.Epochs{}, err
	}
	contentCounter, err := dynamoutil.AttrInt(item, "contentCounter")
	if err != nil {
		return logstore.Epochs{}, err
	}
	return logstore.Epochs{Meta: metaCounter, Content: contentCounter}, nil
}

// Peek is Read's cheap half exposed for polling — see logstore.Store.Peek.
// A requested syncID with no #control item is simply absent from the
// result, the per-item analog of getControlState's ErrCircleNotFound.
func (s *Store) Peek(ctx context.Context, syncIDs []string) (map[string]logstore.Epochs, error) {
	result := make(map[string]logstore.Epochs, len(syncIDs))
	if len(syncIDs) == 0 {
		return result, nil
	}

	// Deduplicated because BatchGetItem rejects the whole request with a
	// ValidationException if the same key appears twice — and a caller
	// asking about the same circle twice wants an answer, not an error.
	seen := make(map[string]bool, len(syncIDs))
	keys := make([]map[string]types.AttributeValue, 0, len(syncIDs))
	for _, syncID := range syncIDs {
		if seen[syncID] {
			continue
		}
		seen[syncID] = true
		keys = append(keys, controlKey(syncID))
	}

	requestItems := map[string]types.KeysAndAttributes{
		s.tableName: {Keys: keys, ConsistentRead: aws.Bool(false)},
	}
	for attempt := 0; len(requestItems) > 0; attempt++ {
		// UnprocessedKeys means DynamoDB throttled part of the batch.
		// Resubmitting immediately would add load to a table already
		// pushing back (and spin a Lambda invocation hot doing it), so
		// each retry waits a little longer than the last.
		if attempt > 0 {
			if err := sleepBackoff(ctx, attempt); err != nil {
				return nil, err
			}
		}

		out, err := s.client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: requestItems})
		if err != nil {
			return nil, err
		}
		for _, item := range out.Responses[s.tableName] {
			syncID, ok := dynamoutil.AttrString(item, dynamoutil.PKAttr)
			if !ok {
				continue
			}
			epochs, err := parseControlEpochs(item)
			if err != nil {
				return nil, err
			}
			result[syncID] = epochs
		}
		requestItems = out.UnprocessedKeys
	}
	return result, nil
}

// sleepBackoff waits out one retry of an exponential backoff, or returns
// early if ctx is cancelled first — a request that's already given up
// shouldn't hold the invocation open sleeping.
func sleepBackoff(ctx context.Context, attempt int) error {
	// Bitwise multiplication by 2 per attempt: 20ms, 40ms, 80ms, ... capped below.
	delay := peekRetryBaseDelay << (attempt - 1)
	if delay > peekRetryMaxDelay {
		delay = peekRetryMaxDelay
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (s *Store) lookupIdempotencyMarker(ctx context.Context, syncID string, ns logstore.Namespace, entryID string) (*logstore.CommitResult, error) {
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
	return &logstore.CommitResult{Epoch: epoch, ReceivedAt: receivedAt}, nil
}

// Read never deletes or evicts — nothing to reconcile against
// retention, unlike an earlier TTL-eviction design this store replaced:
// entries are retained and immutable forever now, so there's no expiry
// to reconcile against. A circle with no control state yet (never
// Bootstrapped) reads back
// as empty rather than an error — Read is used for ordinary catch-up
// sync, where "nothing here yet" is a normal state, not a caller mistake.
func (s *Store) Read(ctx context.Context, syncID string, ns logstore.Namespace, sinceEpoch int64) (logstore.FetchResult, error) {
	if !ns.Valid() {
		return logstore.FetchResult{}, logstore.ErrInvalidNamespace
	}

	control, err := s.getControlState(ctx, syncID, false)
	if errors.Is(err, logstore.ErrCircleNotFound) {
		return logstore.FetchResult{Entries: []logstore.LogEntry{}}, nil
	}
	if err != nil {
		return logstore.FetchResult{}, err
	}
	currentEpoch := control.counter(ns)

	// Loops rather than one Query call: DynamoDB caps a single response at
	// 1MB regardless of readPageSize — an unpaginated call would silently
	// truncate once a namespace's backlog crosses that size.
	entries := make([]logstore.LogEntry, 0, readPageSize)
	var exclusiveStartKey map[string]types.AttributeValue
	for len(entries) < readPageSize {
		queryOut, err := s.client.Query(ctx, &dynamodb.QueryInput{
			TableName:              aws.String(s.tableName),
			KeyConditionExpression: aws.String(fmt.Sprintf("%s = :pk AND %s BETWEEN :lower AND :upper", dynamoutil.PKAttr, dynamoutil.SKAttr)),
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":pk":    &types.AttributeValueMemberS{Value: syncID},
				":lower": &types.AttributeValueMemberS{Value: entrySK(ns, sinceEpoch+1)},
				":upper": &types.AttributeValueMemberS{Value: entrySKUpperBound(ns)},
			},
			ScanIndexForward:  aws.Bool(true),
			Limit:             aws.Int32(int32(readPageSize - len(entries))),
			ExclusiveStartKey: exclusiveStartKey,
		})
		if err != nil {
			return logstore.FetchResult{}, err
		}

		for _, item := range queryOut.Items {
			epoch, err := dynamoutil.AttrInt(item, "epoch")
			if err != nil {
				return logstore.FetchResult{}, err
			}
			keyVersion, err := dynamoutil.AttrInt(item, "keyVersion")
			if err != nil {
				return logstore.FetchResult{}, err
			}
			receivedAt, err := dynamoutil.AttrInt(item, "receivedAt")
			if err != nil {
				return logstore.FetchResult{}, err
			}
			// Absent on a DeleteEntry-stripped row (never on any other kind —
			// everything else always writes it). Empty rather than an error:
			// the client's own decrypt already treats malformed/absent
			// ciphertext as unreadable and skips it, same as any entry it
			// lacks the key version for.
			var meta []byte
			if blobAttr, ok := item["encryptedMeta"].(*types.AttributeValueMemberB); ok {
				meta = blobAttr.Value
			}
			// Absent on rows written by Rotate/ChangeAuthority/DeleteCircle,
			// and on any row from before this field existed — AttrString
			// returns "" for both, same as commit's own omit-when-empty
			// write side.
			authorIdentityPublicKey, _ := dynamoutil.AttrString(item, "authorIdentityPublicKey")
			deletedAt, _ := dynamoutil.AttrInt(item, "deletedAt")
			entries = append(entries, logstore.LogEntry{
				Epoch:                   epoch,
				KeyVersion:              keyVersion,
				EncryptedMeta:           meta,
				ReceivedAt:              receivedAt,
				DeletedAt:               deletedAt,
				AuthorIdentityPublicKey: authorIdentityPublicKey,
			})
		}

		if queryOut.LastEvaluatedKey == nil {
			break
		}
		exclusiveStartKey = queryOut.LastEvaluatedKey
	}
	// No sort needed: ScanIndexForward already returns each page in
	// ascending epoch order, and consecutive pages continue that same
	// order, so entries is already fully sorted by the time this loop ends.

	return logstore.FetchResult{Entries: entries, CurrentEpoch: currentEpoch}, nil
}

// VerifyWriteToken is a plain, non-consistent read-and-compare — no CAS
// loop needed, since nothing is mutated. Deliberately eventually
// consistent: this gates a read-shaped operation (obtaining an upload
// URL), where being briefly stale after a rotation just means a retry,
// the same tolerance Read already has.
func (s *Store) VerifyWriteToken(ctx context.Context, syncID, writeToken string) error {
	control, err := s.getControlState(ctx, syncID, false)
	if err != nil {
		return err
	}
	expectedHash, err := hashWriteToken(writeToken)
	if err != nil || control.writeTokenHash != expectedHash {
		return logstore.ErrWriteTokenMismatch
	}
	return nil
}

// VerifyAuthoritySignature checks cryptographic validity first (so a
// forged signature never triggers a storage read for a syncID that may
// not even exist), then confirms authorityPublicKey is actually a member
// of syncID's current authority set. Same non-consistent-read tolerance
// as VerifyWriteToken — this gates a read-shaped operation, where being
// briefly stale after an authority-set change just means a retry.
func (s *Store) VerifyAuthoritySignature(ctx context.Context, syncID, authorityPublicKey string, message []byte, signature []byte) error {
	if err := verifyAuthoritySignature(authorityPublicKey, message, signature); err != nil {
		return err
	}
	control, err := s.getControlState(ctx, syncID, false)
	if err != nil {
		return err
	}
	if !control.authoritySet[authorityPublicKey] {
		return logstore.ErrAuthorityNotRecognized
	}
	return nil
}

func hashWriteToken(writeTokenHex string) (string, error) {
	raw, err := hex.DecodeString(writeTokenHex)
	if err != nil {
		return "", fmt.Errorf("write token is not valid hex: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// verifyAuthoritySignature checks cryptographic validity only — whether
// authorityPublicKeyHex is actually a key the circle currently recognizes
// is a separate, storage-backed check (see Rotate). ed25519.Verify panics
// on a wrong-length key or signature rather than returning false, so
// lengths are validated first — a malformed request must fail cleanly,
// not crash the process.
func verifyAuthoritySignature(authorityPublicKeyHex string, message []byte, signature []byte) error {
	pubKey, err := hex.DecodeString(authorityPublicKeyHex)
	if err != nil || len(pubKey) != ed25519.PublicKeySize {
		return logstore.ErrInvalidSignature
	}
	if len(signature) != ed25519.SignatureSize {
		return logstore.ErrInvalidSignature
	}
	if !ed25519.Verify(ed25519.PublicKey(pubKey), message, signature) {
		return logstore.ErrInvalidSignature
	}
	return nil
}

// withCASValues fills in the placeholders every ChangeAuthority attempt
// shares, alongside whichever the action added.
func withCASValues(values map[string]types.AttributeValue, expectedHash string, current, nextEpoch int64, change logstore.AuthorityChange) map[string]types.AttributeValue {
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

// validAuthorityKeyHex checks a key being written *into* the set, which
// no signature covers — the key's owner isn't the one calling. Nothing
// can sign as a malformed one, so it could never remove itself again.
func validAuthorityKeyHex(publicKeyHex string) bool {
	raw, err := hex.DecodeString(publicKeyHex)
	return err == nil && len(raw) == ed25519.PublicKeySize
}
