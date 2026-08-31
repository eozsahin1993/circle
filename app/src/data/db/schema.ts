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
