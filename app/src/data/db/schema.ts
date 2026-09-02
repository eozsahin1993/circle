import { sql } from 'drizzle-orm';
import { blob, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const circles = sqliteTable('circles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Cover photo picked on creation, if any — separate from any post's photo. */
  picture: blob('picture').$type<Uint8Array>(),
  createdAt: integer('created_at').notNull(),
  /** Set when this device leaves the circle — kept (not deleted) so already-synced posts stay as a local archive. */
  leftAt: integer('left_at'),
});

export const circleMembers = sqliteTable(
  'circle_members',
  {
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    memberId: text('member_id').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
    name: text('name').notNull(),
    picture: blob('picture').$type<Uint8Array>(),
    joinedAt: integer('joined_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.circleId, t.publicKey] }),
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
    photo: blob('photo').$type<Uint8Array>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('posts_circle_id').on(t.circleId)]
);

export const postReactions = sqliteTable(
  'post_reactions',
  {
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /**
     * The reacting member's compact self-reference (see `memberId` on
     * circleMembers) — not their public key. A reaction is exactly the
     * "member self-assigns a reference to their own action" case that
     * field exists for; it doesn't need cryptographic verification the
     * way a post signature would.
     */
    memberId: text('member_id').notNull(),
    /**
     * One grapheme cluster (a single emoji, however many UTF-16 code
     * units that takes for ZWJ sequences/skin tones/flags) — not
     * validated at the schema level; callers are responsible for that.
     */
    emoji: text('emoji').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // One row per (post, member, emoji) — reacting again with the same
    // emoji is a toggle-off (delete the row), not a duplicate; the same
    // member can still hold several different emoji on one post.
    primaryKey({ columns: [t.postId, t.memberId, t.emoji] }),
    index('post_reactions_post_id').on(t.postId),
  ]
);

/**
 * Strict local ordering for locally-created content awaiting push to the
 * relay — see server/DESIGN.md. `sequenceNum` (not `createdAt`) is what
 * `drainOutbox` pushes in order: a DB-assigned autoincrement is gap-free
 * and unambiguous by construction, where comparing timestamps across
 * (eventually several) locally-originated entry types would not be.
 * `epoch` stays null until the relay confirms the push; entryType is
 * 'post' only for now but kept generic since comments/reactions will
 * eventually queue through here too.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    sequenceNum: integer('sequence_num').primaryKey({ autoIncrement: true }),
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    entryType: text('entry_type', { enum: ['post', 'member_added'] }).notNull(),
    localId: text('local_id').notNull(),
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
    /** Compact self-reference, same as postReactions.memberId — see that column's comment. */
    memberId: text('member_id').notNull(),
    /**
     * The author's display name at the moment they commented, copied
     * here rather than joined from circleMembers — same denormalization
     * circleMembers itself already uses for its own name/picture. Avoids
     * an N+1 lookup per comment, and means a later name change doesn't
     * retroactively rewrite what old comments show.
     */
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('post_comments_post_id').on(t.postId)]
);
