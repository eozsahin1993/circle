/**
 * The JSON shapes carried inside the invite flow's encrypted mailbox rows
 * (see server/INVITE_FLOW.md). Shared between invite-to-circle.ts (creator
 * side) and join-circle.ts (requester side) — kept in their own file
 * rather than either usecase, since both sides need to encode one of these
 * and decode another, and neither side should import the other's module
 * just for a type.
 */

/**
 * What an invite's row (`sk = "invite"`) decrypts to — written once by the
 * creator, read by anyone who taps the invite link, encrypted under
 * `deriveInvitePreviewKey`. Just the name for now — a cover-photo preview
 * is deferred until circle-level "current state" (name/photo as of now,
 * not as of invite-creation) has a real design, rather than bolting a
 * one-off snapshot onto this payload ahead of that.
 */
export type InvitePreviewPayload = {
  name: string;
  /**
   * Hex-encoded Ed25519 public key — the invite creator's own circle
   * identity (see `deriveCircleIdentity`). Carried here, not fetched from
   * anywhere else, because the requester has no other way to learn it
   * before joining: this is what lets a later approval be verified as
   * having actually come from this specific invite's creator (see
   * `JoinApprovalEnvelope`), not just from anyone who happened to know
   * both the invite code and the circle secret.
   */
  createdByPublicKey: string;
};

/**
 * What a join request row's `encryptedRequest` decrypts to — written by
 * the requester, read by the invite's creator, encrypted under
 * `deriveJoinRequestKey`. The self-reported name is explicitly not
 * verified identity — see server/DESIGN.md's "Invites" section.
 */
export type JoinRequestPayload = {
  /** Hex-encoded X25519 public key — the requester's one-time ephemeral keypair for this handshake. */
  ephemeralPub: string;
  selfReportedName: string;
};

/**
 * What a join request's `encryptedApproval` decrypts to, once opened via
 * `openSealedBox` — written by the creator, sealed to the requester's
 * `ephemeralPub` (not code-derived like the two payloads above).
 */
export type JoinApprovalPayload = {
  /** Hex-encoded circle secret. */
  secret: string;
  circleName: string;
};

/**
 * The actual sealed payload: the approval plus a signature over it, made
 * with the *approver's own* circle-identity secret key. The requester
 * verifies this against the `createdByPublicKey` it captured from the
 * invite's preview (see `InvitePreviewPayload`) before trusting `approval`
 * at all — without this, anyone who knows both the invite code and the
 * circle secret (any existing member, not just this invite's creator)
 * could forge a fully-working approval, since the code alone hands them
 * the requester's ephemeralPub and the secret is the same one every
 * member already has. Signing binds the approval to the one identity that
 * actually matters: the specific device that created this invite.
 */
export type JoinApprovalEnvelope = {
  approval: JoinApprovalPayload;
  /** Hex-encoded Ed25519 signature over `JSON.stringify(approval)`, by `createdByPublicKey`'s matching secret key. */
  signature: string;
};
