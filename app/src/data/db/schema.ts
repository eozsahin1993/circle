import { sql } from 'drizzle-orm';
import { blob, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const circles = sqliteTable('circles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Cover photo picked on creation, if any — separate from any post's photo. */
  picture: blob('picture').$type<Uint8Array>(),
  /**
   * The relay-facing address for this circle's log — random, independent
   * of key material so rotation never repoints it. Stored, never derived
   * — see server/SYNC_DESIGN.md's "Identifiers... stay decoupled" invariant.
   */
  syncId: text('sync_id').notNull().default(''),
  createdAt: integer('created_at').notNull(),
  /** Set when this device leaves the circle — kept (not deleted) so already-synced posts stay as a local archive. */
  leftAt: integer('left_at'),
  /** How far this device has synced each namespace — see server/SYNC_DESIGN.md's "Read / sync". 0 means never synced. */
  metaCursor: integer('meta_cursor').notNull().default(0),
  contentCursor: integer('content_cursor').notNull().default(0),
});

export const circleMembers = sqliteTable(
  'circle_members',
  {
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    /** Ed25519 signing key (hex) — see `deriveCircleIdentity`. Verifies who signed a log entry. */
    identityPublicKey: text('identity_public_key').notNull(),
    /**
     * X25519 sealing key (hex) — see `deriveCircleSealingKeypair`. Needed
     * to seal a rotated content key to this member. Defaults to '' so
     * `ALTER TABLE ADD COLUMN` stays valid against existing rows.
     */
    encPublicKey: text('enc_public_key').notNull().default(''),
    memberId: text('member_id').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
    name: text('name').notNull(),
    picture: blob('picture').$type<Uint8Array>(),
    joinedAt: integer('joined_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.circleId, t.identityPublicKey] }),
    uniqueIndex('circle_members_member_id').on(t.circleId, t.memberId),
  ]
);

export const deviceProfile = sqliteTable(
  'device_profile',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    picture: blob('picture').$type<Uint8Array>(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [check('device_profile_id_check', sql`${t.id} = 0`)]
);

export const circleInvites = sqliteTable(
  'circle_invites',
  {
    code: text('code').primaryKey(),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    createdByPublicKey: text('created_by_public_key').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
  },
  (t) => [index('circle_invites_circle_id').on(t.circleId)]
);

export const posts = sqliteTable(
  'posts',
  {
    id: text('id').primaryKey(),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    caption: text('caption').notNull(),
    /**
     * The author's circle identity public key (hex, Ed25519) — the same
     * value a pulled entry's envelope is signed with, and the
     * `circleMembers` row key. Deliberately *not* a denormalized name or
     * avatar: both resolve live from `circleMembers` at render time, so a
     * member renaming themselves updates every post they ever made (see
     * server/SYNC_DESIGN.md's "One identifier, four jobs").
     */
    authorPublicKey: text('author_public_key').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('posts_circle_id').on(t.circleId)]
);

/**
 * Every encrypted blob this device knows about but may not hold yet —
 * post photos and circle cover photos alike. Modelled as its own table
 * because a blob has a lifecycle its owner doesn't: where to fetch it
 * from, whether it's arrived, and what to do about it if it hasn't. A
 * pulled post exists locally the moment its log entry is applied; its
 * bytes arrive later, out of band (see photo-queue.ts), so "post" and
 * "bytes of that post" are genuinely two things with two states.
 *
 * Keyed by `(circleId, entryId)` because that's how the relay itself
 * addresses blobs — GET /v1/circles/{syncId}/entries/{entryId}/blob — so
 * one download queue and one backoff policy serve every kind, and a
 * future kind (member avatars, at `{syncId}/avatar/{pubkey}`) is a new
 * `kind` value rather than a new table.
 *
 * Rows are created two ways, and both go through here rather than one
 * path bypassing it: locally-created content inserts `status: 'fetched'`
 * with bytes already in hand, and pulled content inserts
 * `status: 'pending'` with `bytes: null`.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    /**
     * The blob's stable relay-side address within its circle. A post
     * photo's is its `postId` (the id `drainOutbox` uploads under); a
     * circle cover's is the literal `'cover'`. Deliberately not a URL —
     * download URLs are presigned and expire, so they can't be persisted.
     *
     * `(circleId, entryId)` is the primary key rather than a synthetic id
     * because it's exactly how the relay addresses the blob, so there's
     * no second identity to keep in sync — and it's what makes
     * re-applying an already-seen entry a no-op instead of a duplicate.
     */
    /**
     * The id this entry is appended under at the relay — passed straight
     * to `appendEntry`, which makes it the relay's idempotency key, and
     * for a post also its blob address (`{syncId}/{entryId}` in S3).
     *
     * For posts and comments it's the same id as the local row, so every
     * device ends up naming that content identically. For reactions it's
     * a fresh id per toggle that refers to nothing local: reusing one
     * would let the relay read a re-reaction as a retry of the removal
     * and drop it.
     */
    entryId: text('entry_id').notNull(),
    /**
     * What this blob is for — decides where the bytes get rendered once
     * they land, and is why the fetcher itself never has to care.
     */
    kind: text('kind', { enum: ['post_photo', 'circle_cover'] }).notNull(),
    /** Decrypted bytes, once downloaded. Null while status is 'pending'/'failed'. */
    bytes: blob('bytes').$type<Uint8Array>(),
    /**
     * sha256 of the decrypted bytes, from the owning entry's *signed*
     * payload (see create-post.ts) — what verifies a download, since an
     * entry's signature can't cover a blob uploaded separately. '' when
     * nothing signed a hash for it (a circle cover, today).
     */
    hash: text('hash').notNull(),
    /** Which content-key version decrypts the blob — the version its entry used. */
    keyVersion: integer('key_version').notNull(),
    status: text('status', { enum: ['pending', 'fetched', 'failed'] }).notNull(),
    fetchAttempts: integer('fetch_attempts').notNull().default(0),
    /** Epoch ms before which a failed download won't be retried; null = eligible now. */
    nextAttemptAt: integer('next_attempt_at'),
    /**
     * When the owning content was created, copied here so the download
     * queue can order by recency without joining anything — see
     * `getFetchableAttachments`, the hottest query in the photo engine.
     */
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.circleId, t.entryId] }), index('attachments_circle_id').on(t.circleId)]
);

export const postReactions = sqliteTable(
  'post_reactions',
  {
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /**
     * The reacting member's circle identity public key (hex, Ed25519) —
     * same identifier posts and comments use. It was `memberId`, which
     * is self-assigned per device and never travels on the wire, so a
     * synced reaction could not be attributed anywhere but its author's
     * own phone.
     */
    authorPublicKey: text('author_public_key').notNull(),
    /**
     * One grapheme cluster (a single emoji, however many UTF-16 code
     * units that takes for ZWJ sequences/skin tones/flags) — not
     * validated at the schema level; callers are responsible for that.
     */
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // One row per (post, author, emoji) — reacting again with the same
    // emoji is a toggle-off (delete the row), not a duplicate; the same
    // member can still hold several different emoji on one post.
    primaryKey({ columns: [t.postId, t.authorPublicKey, t.emoji] }),
    index('post_reactions_post_id').on(t.postId),
  ]
);

/**
 * Strict local ordering for locally-created content awaiting push to the
 * relay — see server/DESIGN.md. `sequenceNum` (not `createdAt`) is what
 * `drainOutbox` pushes in order: a DB-assigned autoincrement is gap-free
 * and unambiguous by construction, where comparing timestamps across
 * (eventually several) locally-originated entry types would not be.
 * `epoch` stays null until the relay confirms the push.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    sequenceNum: integer('sequence_num').primaryKey({ autoIncrement: true }),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    entryType: text('entry_type', { enum: ['post', 'comment', 'reaction', 'member_added', 'profile_update'] }).notNull(),
    /**
     * The id this entry is appended under at the relay — passed straight
     * to `appendEntry`, which makes it the relay's idempotency key, and
     * for a post also its blob address (`{syncId}/{entryId}` in S3).
     *
     * For posts and comments it's the same id as the local row, so every
     * device ends up naming that content identically. For reactions it's
     * a fresh id per toggle that refers to nothing local: reusing one
     * would let the relay read a re-reaction as a retry of the removal
     * and drop it.
     */
    entryId: text('entry_id').notNull(),
    /**
     * The exact ciphertext `drainOutbox` will POST as-is — built and
     * encrypted once, at enqueue time, not re-derived from `posts` when
     * the push actually happens. Two reasons that matters: a retry must
     * send byte-for-byte the same thing it did the first time (the
     * relay's idempotency is keyed on entryId, not payload — if a retry's
     * bytes differed, the relay would silently keep the first attempt's
     * content and drop the retry's), and a locally-created row can be
     * queued for a while before it actually goes out, during which
     * `posts` itself could in principle change under it.
     */
    encryptedMeta: blob('encrypted_meta').$type<Uint8Array>().notNull(),
    /**
     * Decoupled from `epoch` on purpose: today the two always move
     * together (pending -> synced, right when epoch is first set), but a
     * separate status leaves room for a later 'failed' state — a
     * permanently-failed push and a not-yet-attempted one would otherwise
     * both just look like `epoch IS NULL`, with no way to tell them apart.
     */
    status: text('status', { enum: ['pending', 'synced'] }).notNull(),
    epoch: integer('epoch'),
  },
  (t) => [index('outbox_circle_id').on(t.circleId)]
);

/**
 * One row per outstanding join request this device has submitted — lets a
 * "pending for Family Circle" screen survive the app being closed and
 * reopened before approval ever lands (see server/INVITE_FLOW.md, step 4).
 * `id` is the requester-chosen id used both as the mailbox row's sort key
 * suffix and as the Keychain key for the matching ephemeral secret key
 * (see `keystore.ts`'s `savePendingJoinKeypair`) — the secret key itself
 * never lives here. `status` is 'approved' only for the brief window
 * between decrypting the approval and finishing local setup; the row is
 * deleted entirely once that completes, so there's no long-lived "joined"
 * state to track here.
 */
export const pendingJoinRequests = sqliteTable('pending_join_requests', {
  id: text('id').primaryKey(),
  /**
   * The local circleId minted when the request was made, parked here
   * until approval. It has to exist that early because the requester's
   * identity is derived from it and its public half ships in the request
   * — and it has to be *remembered*, since deriving the same keypair
   * again later requires the same id (see server/README.md's identity
   * model). `completeJoin` adopts this as the circle row's `id`.
   */
  circleId: text('circle_id').notNull(),
  inviteCode: text('invite_code').notNull(),
  /** From the decrypted invite preview — shown on the pending screen without needing to re-fetch/re-decrypt it. */
  circleName: text('circle_name').notNull(),
  /** Also from the decrypted invite preview — the creator's self-reported display name, shown on the pending screen ("X needs to let you in"). Defaults to '' (matches profile?.name ?? '' elsewhere) so ALTER TABLE ADD COLUMN stays valid against existing local rows. */
  createdByName: text('created_by_name').notNull().default(''),
  /**
   * Also from the decrypted invite preview — the invite creator's own
   * circle-identity public key (hex, Ed25519), kept locally so a later
   * approval's signature can be verified against it without a second
   * fetch. See `JoinApprovalEnvelope`'s doc comment for why this matters:
   * without it, any existing member who knows the invite code could forge
   * a working approval, not just this invite's actual creator.
   */
  createdByPublicKey: text('created_by_public_key').notNull(),
  /** Hex-encoded X25519 public key; the matching secret key is in Keychain, never here. */
  ephemeralPublicKey: text('ephemeral_public_key').notNull(),
  submittedAt: integer('submitted_at').notNull(),
  status: text('status', { enum: ['pending', 'approved'] }).notNull().default('pending'),
});

export const postComments = sqliteTable(
  'post_comments',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /**
     * The author's circle identity public key (hex, Ed25519) — the same
     * identifier posts use, and for the same reason: it is what a synced
     * entry's signature is verified against, and the `circleMembers` row
     * key. Replaced `memberId` + `authorName`, neither of which could
     * survive syncing — `memberId` is self-assigned per device and never
     * travels on the wire, and a denormalized name froze whatever the
     * author was called at the time (literally "You" when they had no
     * profile name yet). Both now resolve live from the roster, so
     * renaming yourself updates every comment you ever made.
     */
    authorPublicKey: text('author_public_key').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('post_comments_post_id').on(t.postId)]
);
