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

// DeleteCircle verifies the signer's signature over deletion.Message(),
// then hashes deletion.WriteToken and calls LogStore.DeleteCircle.
func (s *Service) DeleteCircle(ctx context.Context, deletion CircleDeletion) (CommitResult, error) {
	if err := VerifySignature(deletion.SignerAuthorityPublicKey, deletion.Message(), deletion.Signature); err != nil {
		return CommitResult{}, err
	}
	writeTokenHash, err := WriteTokenHash(deletion.WriteToken)
	if err != nil {
		return CommitResult{}, ErrWriteTokenMismatch
	}
	return s.Log.DeleteCircle(ctx, deletion.SyncID, deletion.EntryID, deletion.EncryptedPayload, deletion.KeyVersion, writeTokenHash, deletion.SignerAuthorityPublicKey)
}

// DeleteEntry finds the target post, then verifies whichever capability
// authorizes deleting it: the post's own author first, falling back to a
// circle admin. The admin path passes its own key through to LogStore as
// requiredAuthorityPublicKey rather than verifying membership here —
// unlike a plain read, this authorizes a write, so membership has to be
// re-checked atomically alongside the commit that lands the tombstone,
// not against state read moments earlier.
func (s *Service) DeleteEntry(ctx context.Context, deletion EntryDeletion) (CommitResult, error) {
	post, err := s.Log.FindEntry(ctx, deletion.SyncID, deletion.TargetEntryID)
	if err != nil {
		return CommitResult{}, err
	}

	authorizedBy := post.AuthorIdentityPublicKey
	var requiredAuthorityPublicKey string
	if VerifySignature(post.AuthorIdentityPublicKey, deletion.Message(), deletion.AuthorSignature) != nil {
		if deletion.AuthorityPublicKey == "" || len(deletion.AuthoritySignature) == 0 {
			return CommitResult{}, ErrEntryNotAuthorized
		}
		if err := VerifySignature(deletion.AuthorityPublicKey, deletion.Message(), deletion.AuthoritySignature); err != nil {
			return CommitResult{}, err
		}
		authorizedBy = deletion.AuthorityPublicKey
		requiredAuthorityPublicKey = deletion.AuthorityPublicKey
	}

	writeTokenHash, err := WriteTokenHash(deletion.WriteToken)
	if err != nil {
		return CommitResult{}, ErrWriteTokenMismatch
	}
	return s.Log.DeleteEntry(ctx, deletion.SyncID, deletion.TombstoneEntryID, post.Epoch, deletion.EncryptedPayload, deletion.KeyVersion, writeTokenHash, authorizedBy, requiredAuthorityPublicKey)
}
