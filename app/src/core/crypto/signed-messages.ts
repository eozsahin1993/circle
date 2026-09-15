/**
 * The exact byte sequence an authority signature must cover for a rotate
 * call — must match the relay's own `logstore.RotateMessage` byte-for-byte.
 */
export function deriveRotateMessage(syncId: string, entryId: string, newWriteTokenHash: string): Uint8Array {
  return new TextEncoder().encode(`circle-relay/rotate/v1\x00${syncId}\x00${entryId}\x00${newWriteTokenHash}`);
}

/** The two directions an authority key can move across the relay's set. */
export const AuthorityActions = { add: 'add', remove: 'remove' } as const;

export type AuthorityAction = (typeof AuthorityActions)[keyof typeof AuthorityActions];

/**
 * The exact byte sequence an authority signature must cover to add or
 * remove a key from a circle's authority set — must match the relay's own
 * `logstore.AuthorityChange.Message` byte-for-byte. Bound to the action
 * as well as the target, so a promotion's signature can't be turned into
 * the demotion of the same person.
 */
export function deriveAuthorityChangeMessage(
  action: AuthorityAction,
  syncId: string,
  entryId: string,
  targetAuthorityPublicKey: string
): Uint8Array {
  return new TextEncoder().encode(`circle-relay/authority-change/v1\x00${action}\x00${syncId}\x00${entryId}\x00${targetAuthorityPublicKey}`);
}

/**
 * The exact byte sequence an authority key must sign to prove its owner
 * actually holds it, before anyone will believe the key belongs to them.
 *
 * Bound to the member's *identity* public key, which is itself derived
 * from their seed and this circle, so the proof is worthless to anyone
 * else: publishing a key you don't hold means producing this signature
 * with a secret you don't have. Nothing on the relay checks it — the
 * payload is opaque there — so this is purely a between-clients contract,
 * unlike the three messages above.
 */
export function deriveAuthorityKeyProofMessage(identityPublicKey: string): Uint8Array {
  return new TextEncoder().encode(`circle-relay/authority-key-proof/v1\x00${identityPublicKey}`);
}

/**
 * The exact byte sequence an authority signature must cover to obtain a
 * cover-photo upload URL — must match the relay's own
 * `logstore.CoverPhotoUploadMessage` byte-for-byte.
 */
export function deriveCoverPhotoUploadMessage(syncId: string): Uint8Array {
  return new TextEncoder().encode(`circle-relay/cover-photo-upload/v1\x00${syncId}`);
}

/**
 * The exact byte sequence an authority signature must cover to delete a
 * blob this device didn't upload — must match the relay's own
 * `logstore.DeleteBlobMessage` byte-for-byte. Bound to the entry, so one
 * signature authorizes destroying one photo.
 */
export function deriveDeleteBlobMessage(syncId: string, entryId: string): Uint8Array {
  return new TextEncoder().encode(`circle-relay/delete-blob/v1\x00${syncId}\x00${entryId}`);
}

/**
 * The exact byte sequence an authority signature must cover to delete a
 * circle — must match the relay's own `logstore.CircleDeletion.Message()`
 * byte-for-byte. Bound to the tombstone's entry id, so one signature ends
 * one circle rather than authorizing a deletion the caller can replay.
 */
export function deriveDeleteCircleMessage(syncId: string, entryId: string): Uint8Array {
  return new TextEncoder().encode(`circle-relay/delete-circle/v1\x00${syncId}\x00${entryId}`);
}

/**
 * The exact byte sequence a signature must cover to delete a post — must
 * match the relay's own `logstore.PostDeletion.Message()` byte-for-byte.
 * Bound to both the post and the tombstone entry id, so one signature
 * can't be replayed against a different tombstone attempt later.
 */
export function deriveDeleteEntryMessage(syncId: string, entryId: string, tombstoneEntryId: string): Uint8Array {
  return new TextEncoder().encode(`circle-relay/delete-entry/v1\x00${syncId}\x00${entryId}\x00${tombstoneEntryId}`);
}

/**
 * The exact byte sequence a signature must cover to erase everything one
 * identity authored in a circle — must match the relay's
 * `logstore.AuthorContentDeletion.Message()` byte-for-byte.
 * `tombstoneEntryId` is the empty string in strip-only mode (a circle
 * already departed, where no tombstone can be appended).
 */
export function deriveDeleteAuthorContentMessage(
  syncId: string,
  authorIdentityPublicKey: string,
  tombstoneEntryId: string
): Uint8Array {
  return new TextEncoder().encode(
    `circle-relay/delete-author-content/v1\x00${syncId}\x00${authorIdentityPublicKey}\x00${tombstoneEntryId}`
  );
}
