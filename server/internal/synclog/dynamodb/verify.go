package dynamodb

import (
	"context"

	"mimoza-relay/internal/synclog"
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
	expectedHash, err := synclog.WriteTokenHash(writeToken)
	if err != nil || control.writeTokenHash != expectedHash {
		return synclog.ErrWriteTokenMismatch
	}
	if control.deleted {
		return synclog.ErrCircleDeleted
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
	if err := synclog.VerifySignature(authorityPublicKey, message, signature); err != nil {
		return err
	}
	control, err := s.getControlState(ctx, syncID, false)
	if err != nil {
		return err
	}
	if control.deleted {
		return synclog.ErrCircleDeleted
	}
	if !control.authoritySet[authorityPublicKey] {
		return synclog.ErrAuthorityNotRecognized
	}
	return nil
}
