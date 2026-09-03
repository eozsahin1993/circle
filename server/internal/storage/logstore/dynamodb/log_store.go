// Package dynamodb implements logstore.Store against a single DynamoDB
// table, one partition per syncID. See server/SYNC_DESIGN.md for the
// design and internal/storage/logstore's package doc for the two
// capabilities (write token, authority signature) this enforces.
package dynamodb

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
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

// maxCASAttempts bounds the compare-and-swap retry loop Append and Rotate
// use to keep "check the token/authority" and "bump the counter" atomic
// (see getControlState). Retries only happen under genuine concurrent
// writes to the same circle — vanishingly rare at family-circle scale.
const maxCASAttempts = 5

// idemMarkerTTL is a short, fixed retry window — deliberately not tied to
// any product retention setting (entries and #control never expire; see
// invariant 1). A marker's only job is making a same-entryID retry
// converge shortly after the original commit.
const idemMarkerTTL = 48 * time.Hour

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
func (s *Store) Append(ctx context.Context, syncID string, ns logstore.Namespace, entryID string, encryptedPayload []byte, keyVersion int64, writeToken string) (logstore.CommitResult, error) {
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

		current := control.counter(ns)
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		counterAttr := counterAttrName(ns)
		result, err := s.commit(ctx, syncID, ns, entryID, encryptedPayload, keyVersion, nextEpoch, receivedAt, types.Update{
			TableName:           aws.String(s.tableName),
			Key:                 controlKey(syncID),
			UpdateExpression:    aws.String(fmt.Sprintf("SET %s = :next", counterAttr)),
			ConditionExpression: aws.String(fmt.Sprintf("writeTokenHash = :hash AND %s = :current", counterAttr)),
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
		if !control.authoritySet[authorityPublicKey] {
			return logstore.CommitResult{}, logstore.ErrAuthorityNotRecognized
		}

		current := control.metaCounter
		nextEpoch := current + 1
		receivedAt := dynamoutil.NowMillis()

		result, err := s.commit(ctx, syncID, logstore.NamespaceMeta, entryID, encryptedPayload, currentKeyVersion, nextEpoch, receivedAt, types.Update{
			TableName:           aws.String(s.tableName),
			Key:                 controlKey(syncID),
			UpdateExpression:    aws.String("SET writeTokenHash = :newHash, metaCounter = :next"),
			ConditionExpression: aws.String("writeTokenHash = :currentHash AND metaCounter = :current AND contains(authoritySet, :pubkey)"),
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

// commit runs the three-item transaction shared by Append and Rotate: the
// caller-supplied conditional update to #control (a counter bump, or a
// counter bump plus a token swap), the entry Put, and the idempotency
// marker Put. Returns the raw TransactWriteItems error unexamined —
// callers use convergeOnRace to interpret it.
func (s *Store) commit(ctx context.Context, syncID string, ns logstore.Namespace, entryID string, encryptedPayload []byte, keyVersion, epoch, receivedAt int64, controlUpdate types.Update) (logstore.CommitResult, error) {
	_, err := s.client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Update: &controlUpdate},
			{
				Put: &types.Put{
					TableName: aws.String(s.tableName),
					Item: map[string]types.AttributeValue{
						dynamoutil.PKAttr: &types.AttributeValueMemberS{Value: syncID},
						dynamoutil.SKAttr: &types.AttributeValueMemberS{Value: entrySK(ns, epoch)},
						"epoch":           &types.AttributeValueMemberN{Value: strconv.FormatInt(epoch, 10)},
						"keyVersion":      &types.AttributeValueMemberN{Value: strconv.FormatInt(keyVersion, 10)},
						"encryptedMeta":   &types.AttributeValueMemberB{Value: encryptedPayload},
						"receivedAt":      &types.AttributeValueMemberN{Value: strconv.FormatInt(receivedAt, 10)},
					},
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
}

func (c *controlState) counter(ns logstore.Namespace) int64 {
	if ns == logstore.NamespaceContent {
		return c.contentCounter
	}
	return c.metaCounter
}

// getControlState is the read half of the compare-and-swap Append and
// Rotate build on — a separate read because TransactWriteItems's Update
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
	metaCounter, err := dynamoutil.AttrInt(out.Item, "metaCounter")
	if err != nil {
		return nil, err
	}
	contentCounter, err := dynamoutil.AttrInt(out.Item, "contentCounter")
	if err != nil {
		return nil, err
	}
	return &controlState{
		authoritySet:   authoritySet,
		writeTokenHash: writeTokenHash,
		metaCounter:    metaCounter,
		contentCounter: contentCounter,
	}, nil
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

// Read never deletes or evicts — nothing to reconcile against retention,
// unlike the pre-redesign version (see server/SYNC_DESIGN.md invariant
// 1). A circle with no control state yet (never Bootstrapped) reads back
// as empty rather than an error — Read is used for ordinary catch-up
// sync, where "nothing here yet" is a normal state, not a caller mistake.
func (s *Store) Read(ctx context.Context, syncID string, ns logstore.Namespace, since int64) (logstore.FetchResult, error) {
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
				":lower": &types.AttributeValueMemberS{Value: entrySK(ns, since+1)},
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
			blobAttr, ok := item["encryptedMeta"].(*types.AttributeValueMemberB)
			if !ok {
				return logstore.FetchResult{}, fmt.Errorf("entry at epoch %d missing encryptedMeta", epoch)
			}
			entries = append(entries, logstore.LogEntry{Epoch: epoch, KeyVersion: keyVersion, EncryptedMeta: blobAttr.Value, ReceivedAt: receivedAt})
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
