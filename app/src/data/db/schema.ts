import { sql } from 'drizzle-orm';
import { blob, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const circles = sqliteTable('circles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const circleMembers = sqliteTable(
  'circle_members',
  {
    circleId: text('circle_id')
      .notNull()
      .references(() => circles.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    memberId: text('member_id').notNull(),
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
