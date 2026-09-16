package synclog

import "context"

// Service holds the capability checks that don't depend on live circle
// state — a forged signature never reaches LogStore. HTTP endpoints call
// this instead of LogStore directly.
type Service struct {
	Log LogStore
}

// Rotate verifies the signature before hashing currentWriteToken and
// calling LogStore.Rotate.
func (s *Service) Rotate(ctx context.Context, syncID, entryID string, encryptedPayload []byte, currentKeyVersion int64, currentWriteToken, newWriteTokenHash, authorityPublicKey string, signature []byte) (CommitResult, error) {
	if err := VerifySignature(authorityPublicKey, RotateMessage(syncID, entryID, newWriteTokenHash), signature); err != nil {
		return CommitResult{}, err
	}
	// Malformed and wrong are the same outcome to a caller — one error,
	// not two, for "this token doesn't work."
	currentWriteTokenHash, err := WriteTokenHash(currentWriteToken)
	if err != nil {
		return CommitResult{}, ErrWriteTokenMismatch
	}
	return s.Log.Rotate(ctx, syncID, entryID, encryptedPayload, currentKeyVersion, currentWriteTokenHash, newWriteTokenHash, authorityPublicKey)
}

// ChangeAuthority validates the action and target key shape, verifies the
// signer's signature over change.Message(), then hashes change.WriteToken
// and calls LogStore.ChangeAuthority.
func (s *Service) ChangeAuthority(ctx context.Context, change AuthorityChange) (CommitResult, error) {
	if !change.Action.Valid() {
		return CommitResult{}, ErrInvalidAuthorityAction
	}
	if !ValidPublicKey(change.TargetAuthorityPublicKey) {
		return CommitResult{}, ErrInvalidAuthorityKey
	}
	if err := VerifySignature(change.SignerAuthorityPublicKey, change.Message(), change.Signature); err != nil {
		return CommitResult{}, err
	}
	writeTokenHash, err := WriteTokenHash(change.WriteToken)
	if err != nil {
		return CommitResult{}, ErrWriteTokenMismatch
	}
	return s.Log.ChangeAuthority(ctx, change.SyncID, change.EntryID, change.EncryptedPayload, change.KeyVersion, writeTokenHash, change.Action, change.TargetAuthorityPublicKey, change.SignerAuthorityPublicKey)
}
