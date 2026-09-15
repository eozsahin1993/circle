package dynamodb

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"circle-relay/internal/synclog"
)

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
		return synclog.ErrWriteTokenMismatch
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
		return synclog.ErrAuthorityNotRecognized
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
		return synclog.ErrInvalidSignature
	}
	if len(signature) != ed25519.SignatureSize {
		return synclog.ErrInvalidSignature
	}
	if !ed25519.Verify(ed25519.PublicKey(pubKey), message, signature) {
		return synclog.ErrInvalidSignature
	}
	return nil
}

// validAuthorityKeyHex checks a key being written *into* the set, which
// no signature covers — the key's owner isn't the one calling. Nothing
// can sign as a malformed one, so it could never remove itself again.
func validAuthorityKeyHex(publicKeyHex string) bool {
	raw, err := hex.DecodeString(publicKeyHex)
	return err == nil && len(raw) == ed25519.PublicKeySize
}
