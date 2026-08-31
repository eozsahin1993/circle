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
