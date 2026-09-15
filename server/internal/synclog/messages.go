package synclog

// The seven byte constructions below are a cross-language wire contract —
// app/src/core/crypto/signed-messages.ts must produce byte-identical
// output for each one. See messages_test.go for the golden values both
// sides are checked against. Every construction is version-prefixed and
// null-byte-joined (never bare concatenation) so no combination of field
// values can be reinterpreted as a different message, e.g.
// syncID="ab"+entryID="c" can't collide with syncID="a"+entryID="bc".

// RotateMessage is the exact byte sequence an authority signature must
// cover for a Rotate call. Bound to newWriteTokenHash so it's meaningless
// for any rotation but this exact one.
func RotateMessage(syncID, entryID, newWriteTokenHash string) []byte {
	return []byte("circle-relay/rotate/v1\x00" + syncID + "\x00" + entryID + "\x00" + newWriteTokenHash)
}

// authorityChangeMessage backs AuthorityChange.Message() — bound to every
// part of what it authorizes: the circle, the action (so a promotion's
// signature can't be replayed as the demotion of the same person), the
// target key, and the entry (so one signature moves the set exactly
// once).
func authorityChangeMessage(action AuthorityAction, syncID, entryID, targetAuthorityPublicKey string) []byte {
	return []byte("circle-relay/authority-change/v1\x00" + string(action) + "\x00" + syncID + "\x00" + entryID + "\x00" + targetAuthorityPublicKey)
}

// CoverPhotoUploadMessage is the exact byte sequence an authority
// signature must cover to obtain a cover-photo upload URL — see
// http/getcoverphotouploadtarget. Same construction as RotateMessage, and
// for the same reason: it's what makes the signature mean "I am
// authorizing a cover-photo upload for this circle" specifically, not
// reinterpretable as authorization for anything else this same admin key
// might sign.
func CoverPhotoUploadMessage(syncID string) []byte {
	return []byte("circle-relay/cover-photo-upload/v1\x00" + syncID)
}

// DeleteBlobMessage is the exact byte sequence an authority signature
// must cover to delete a blob the admin did not upload themselves. Bound
// to the entry, so one signature destroys one object rather than any
// blob in the circle.
func DeleteBlobMessage(syncID, entryID string) []byte {
	return []byte("circle-relay/delete-blob/v1\x00" + syncID + "\x00" + entryID)
}

// circleDeletionMessage backs CircleDeletion.Message().
func circleDeletionMessage(syncID, entryID string) []byte {
	return []byte("circle-relay/delete-circle/v1\x00" + syncID + "\x00" + entryID)
}

// entryDeletionMessage backs EntryDeletion.Message() — binds the circle,
// the post, and the tombstone entry; not the lookup, which is never
// signed.
func entryDeletionMessage(syncID, targetEntryID, tombstoneEntryID string) []byte {
	return []byte("circle-relay/delete-entry/v1\x00" + syncID + "\x00" + targetEntryID + "\x00" + tombstoneEntryID)
}

// authorContentDeletionMessage backs AuthorContentDeletion.Message() —
// binds the circle, the author, and the tombstone entry ("" in
// strip-only mode).
func authorContentDeletionMessage(syncID, authorIdentityPublicKey, tombstoneEntryID string) []byte {
	return []byte("circle-relay/delete-author-content/v1\x00" + syncID + "\x00" + authorIdentityPublicKey + "\x00" + tombstoneEntryID)
}
