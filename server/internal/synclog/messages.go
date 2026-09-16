package synclog

// The seven constructions below are a cross-language wire contract —
// app/src/core/crypto/signed-messages.ts must match byte-for-byte; see
// messages_test.go for the golden values both sides check against.
// Version-prefixed and null-byte-joined, never bare concatenation, so no
// field combination collides with another (syncID="ab"+entryID="c" vs
// syncID="a"+entryID="bc").

// RotateMessage is the exact byte sequence an authority signature must
// cover for a Rotate call. Bound to newWriteTokenHash so it's meaningless
// for any rotation but this exact one.
func RotateMessage(syncID, entryID, newWriteTokenHash string) []byte {
	return []byte("mimoza-relay/rotate/v1\x00" + syncID + "\x00" + entryID + "\x00" + newWriteTokenHash)
}

// authorityChangeMessage backs AuthorityChange.Message() — binds the
// action too, so a promotion's signature can't replay as a demotion.
func authorityChangeMessage(action AuthorityAction, syncID, entryID, targetAuthorityPublicKey string) []byte {
	return []byte("mimoza-relay/authority-change/v1\x00" + string(action) + "\x00" + syncID + "\x00" + entryID + "\x00" + targetAuthorityPublicKey)
}

// CoverPhotoUploadMessage is the exact byte sequence an authority
// signature must cover to obtain a cover-photo upload URL — see
// http/getcoverphotouploadtarget.
func CoverPhotoUploadMessage(syncID string) []byte {
	return []byte("mimoza-relay/cover-photo-upload/v1\x00" + syncID)
}

// DeleteBlobMessage is the exact byte sequence an authority signature
// must cover to delete a blob the admin did not upload themselves. Bound
// to the entry, so one signature destroys one object rather than any
// blob in the circle.
func DeleteBlobMessage(syncID, entryID string) []byte {
	return []byte("mimoza-relay/delete-blob/v1\x00" + syncID + "\x00" + entryID)
}

// circleDeletionMessage backs CircleDeletion.Message().
func circleDeletionMessage(syncID, entryID string) []byte {
	return []byte("mimoza-relay/delete-circle/v1\x00" + syncID + "\x00" + entryID)
}

// entryDeletionMessage backs EntryDeletion.Message() — binds the circle,
// the post, and the tombstone entry; not the lookup, which is never
// signed.
func entryDeletionMessage(syncID, targetEntryID, tombstoneEntryID string) []byte {
	return []byte("mimoza-relay/delete-entry/v1\x00" + syncID + "\x00" + targetEntryID + "\x00" + tombstoneEntryID)
}

// authorContentDeletionMessage backs AuthorContentDeletion.Message() —
// binds the circle, the author, and the tombstone entry ("" in
// strip-only mode).
func authorContentDeletionMessage(syncID, authorIdentityPublicKey, tombstoneEntryID string) []byte {
	return []byte("mimoza-relay/delete-author-content/v1\x00" + syncID + "\x00" + authorIdentityPublicKey + "\x00" + tombstoneEntryID)
}
