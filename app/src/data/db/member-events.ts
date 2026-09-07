import { and, asc, eq, isNull } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { circleMembers, memberEvents } from '@/data/db/schema';
import type { MemberRole } from '@/data/db/members';

/**
 * The single write path for anything that changes a circle's roster.
 *
 * The three `record*` functions write twice: a row in `member_events`
 * (history, append-only) and the corresponding state on `circle_members`
 * (who is here now). They're what the sync handlers call, and they're the
 * only things that ever author history.
 *
 * `recordMemberAddedLocally` is the deliberate exception: `createCircle`,
 * `approveJoinRequest` and `completeJoin` all write the roster
 * optimistically so the acting device sees the change immediately, but at
 * that point the entry is still sitting in the outbox and has no epoch
 * yet — there is nothing to key an event row on. Those writes touch state
 * only; the matching history row appears when the entry is pulled back
 * and applied like any other. So: state has two writers, history has one,
 * and both live here rather than being scattered.
 *
 * **Order matters.** The event row goes first, then the projection. The
 * two writes are deliberately *not* wrapped in a transaction: drizzle's
 * expo-sqlite driver commits without awaiting its transaction callback
 * (drizzle-team/drizzle-orm#2275, see migrations/run.ts), so a
 * transaction here would be a false guarantee. Instead a crash between
 * the two is self-healing — the next replay re-applies the same entry,
 * the event insert no-ops on its `(circleId, epoch)` key, and the
 * projection write runs again. That works because every apply is already
 * required to be idempotent (server/SYNC_DESIGN.md invariant 8).
 *
 * **Each write is total, not a patch.** An apply sets every field its
 * event determines rather than only the ones that changed — most
 * importantly `recordMemberAdded` clears `removedAt`. Leaving a stale
 * `removedAt` behind is what would force every caller into
 * `joinedAt > removedAt` comparisons to work out whether someone is
 * actually here; clearing it keeps that a plain `removedAt IS NULL`.
 */

type EventBase = {
  circleId: string;
  /** The entry's relay-assigned epoch — the idempotency key, see schema.ts. */
  epoch: number;
  /** Who the event is about. */
  subjectPublicKey: string;
  /** Who wrote the entry. Equal to the subject when acting on themselves. */
  actorPublicKey: string;
  /** The actor's clock from the entry payload, never this device's. */
  occurredAt: number;
};

/** What a `member_events` row records — see `kind` on `memberEvents` in schema.ts. */
export type MemberEventKind = (typeof memberEvents.$inferSelect)['kind'];

/** The profile fields only an add carries — a removal or role change names an existing row. */
export type AddedMemberProfile = {
  encPublicKey: string;
  memberId: string;
  role: MemberRole;
  name: string;
  picture: Uint8Array | null;
};

/**
 * Records a member joining — or rejoining. The projection is an upsert,
 * not an insert-if-absent: a member who was removed and later re-approved
 * has a row already, and it has to come back with `removedAt` cleared and
 * `joinedAt` moved to this stint. The old `insertMemberIfAbsent` skipped
 * that row entirely, leaving them permanently filtered out of
 * `getCircleMembers`.
 *
 * `name`/`picture`/`role` are only written when the row is new. A
 * returning member's local row may hold a full-resolution picture and a
 * later name, both better than the thumbnail and self-reported name
 * riding on the entry.
 */
export async function recordMemberAdded(event: EventBase & { profile: AddedMemberProfile }): Promise<void> {
  // A self-authored add is the circle being created: `createCircle` is
  // the only writer that signs a member_added naming its own author, and
  // `approveJoinRequest` — whichever admin does the approving — always
  // names someone else. Decided here, once, and stored: a later writer
  // that broke the rule would mislabel new rows without rewriting the
  // history of every circle already recorded.
  const kind = event.actorPublicKey === event.subjectPublicKey ? 'created' : 'added';
  await insertEvent({ ...event, kind, role: event.profile.role });

  await db
    .insert(circleMembers)
    .values({
      circleId: event.circleId,
      identityPublicKey: event.subjectPublicKey,
      encPublicKey: event.profile.encPublicKey,
      memberId: event.profile.memberId,
      role: event.profile.role,
      name: event.profile.name,
      picture: event.profile.picture,
      joinedAt: event.occurredAt,
      removedAt: null,
    })
    .onConflictDoUpdate({
      target: [circleMembers.circleId, circleMembers.identityPublicKey],
      set: { joinedAt: event.occurredAt, removedAt: null },
    });
}

/**
 * Records a member being removed, or leaving (`actorPublicKey` equal to
 * `subjectPublicKey`). Soft removal: the roster row stays so this
 * member's past posts keep passing `authoredByMember`'s ever-member
 * check.
 */
export async function recordMemberRemoved(event: EventBase): Promise<void> {
  await insertEvent({ ...event, kind: 'removed', role: null });

  await db
    .update(circleMembers)
    .set({ removedAt: event.occurredAt })
    .where(and(eq(circleMembers.circleId, event.circleId), eq(circleMembers.identityPublicKey, event.subjectPublicKey)));
}

/**
 * The optimistic half of an add, for the device performing it — the
 * founder creating a circle, an admin approving a request, a joiner
 * completing their own join. Writes state only: there is no epoch yet
 * (the entry is still queued in the outbox), so no event row can be
 * keyed, and one appears anyway once that entry is pulled back and
 * `recordMemberAdded` applies it. Same upsert semantics, so a rejoining
 * member's row is revived rather than skipped.
 */
export async function recordMemberAddedLocally(local: {
  circleId: string;
  subjectPublicKey: string;
  joinedAt: number;
  profile: AddedMemberProfile;
}): Promise<void> {
  const { circleId, subjectPublicKey, joinedAt, profile } = local;
  await db
    .insert(circleMembers)
    .values({
      circleId,
      identityPublicKey: subjectPublicKey,
      encPublicKey: profile.encPublicKey,
      memberId: profile.memberId,
      role: profile.role,
      name: profile.name,
      picture: profile.picture,
      joinedAt,
      removedAt: null,
    })
    .onConflictDoUpdate({
      target: [circleMembers.circleId, circleMembers.identityPublicKey],
      set: { joinedAt, removedAt: null },
    });
}

/**
 * The optimistic half of a removal, for the admin performing it — or for
 * a member leaving on their own. State only, for the same reason as
 * `recordMemberAddedLocally`: no epoch yet.
 *
 * Guarded on `removedAt IS NULL` so a second call can't overwrite the
 * first removal's timestamp with a later one.
 */
export async function recordMemberRemovedLocally(local: {
  circleId: string;
  subjectPublicKey: string;
  removedAt: number;
}): Promise<void> {
  const { circleId, subjectPublicKey, removedAt } = local;
  await db
    .update(circleMembers)
    .set({ removedAt })
    .where(
      and(
        eq(circleMembers.circleId, circleId),
        eq(circleMembers.identityPublicKey, subjectPublicKey),
        isNull(circleMembers.removedAt)
      )
    );
}

/**
 * The optimistic half of a role change, for the admin performing it.
 * State only — see `recordMemberAddedLocally`. Skips removed members: a
 * role on someone who has left means nothing, and if they rejoin
 * `recordMemberAdded` writes the role the new add carries.
 */
export async function recordRoleChangedLocally(local: {
  circleId: string;
  subjectPublicKey: string;
  role: MemberRole;
}): Promise<void> {
  const { circleId, subjectPublicKey, role } = local;
  await db
    .update(circleMembers)
    .set({ role })
    .where(
      and(
        eq(circleMembers.circleId, circleId),
        eq(circleMembers.identityPublicKey, subjectPublicKey),
        isNull(circleMembers.removedAt)
      )
    );
}

/** Records a promotion or demotion. Recorded even while nothing renders it, so the history exists when something does. */
export async function recordRoleChanged(event: EventBase & { role: MemberRole }): Promise<void> {
  await insertEvent({ ...event, kind: 'role_changed', role: event.role });

  await db
    .update(circleMembers)
    .set({ role: event.role })
    .where(and(eq(circleMembers.circleId, event.circleId), eq(circleMembers.identityPublicKey, event.subjectPublicKey)));
}

function insertEvent(row: EventBase & { kind: MemberEventKind; role: MemberRole | null }) {
  return db
    .insert(memberEvents)
    .values({
      circleId: row.circleId,
      epoch: row.epoch,
      kind: row.kind,
      subjectPublicKey: row.subjectPublicKey,
      actorPublicKey: row.actorPublicKey,
      role: row.role,
      occurredAt: row.occurredAt,
    })
    .onConflictDoNothing();
}

/** One roster change, with both sides' names resolved — what the feed renders. */
export type MemberEvent = {
  /** The row's own surrogate id, stringified for the feed's keyExtractor. */
  id: string;
  kind: MemberEventKind;
  /**
   * Shouldn't be null in practice — every handler's predicate requires the
   * author to be a current admin, so their own `member_added` was applied
   * at a lower epoch or this entry was skipped and no row exists to
   * render. Nullable anyway because the alternative (an inner join) would
   * silently drop the event from the feed if that ever stopped holding,
   * and a line missing its attribution beats a line that vanishes.
   */
  actorName: string | null;
  /** True when the member acted on themselves: founder creating the circle, or leaving. */
  selfInflicted: boolean;
  /** Both sides' keys, so a caller holding this device's identity can render the line in the second person. */
  subjectPublicKey: string;
  actorPublicKey: string;
  /**
   * Empty only in the window where `insertEvent` has landed but the roster
   * write behind it hasn't — see the ordering note at the top. The next
   * replay heals it.
   */
  subjectName: string;
  role: MemberRole | null;
  occurredAt: number;
};

/**
 * Every roster change in a circle, newest first — read straight off
 * `member_events` rather than reconstructed from `circle_members`, which
 * could only ever synthesize one join and one removal per person.
 *
 * Both names are resolved against the current roster rather than stored
 * on the event, so a rename propagates to every line that member appears
 * in. An actor with no roster row (their own `member_added` was rejected,
 * or never arrived) resolves to null and that line renders unattributed
 * instead of disappearing.
 *
 * The resolution is a second query and a Map rather than two aliased
 * self-joins: both aliases would select a column named `name`, and the
 * driver hands back one object per row keyed by column name, so one
 * silently overwrites the other. A circle's roster is small enough that
 * reading it whole costs nothing.
 */
export async function getCircleMemberEvents(circleId: string): Promise<MemberEvent[]> {
  const [rows, roster] = await Promise.all([
    db
      .select()
      .from(memberEvents)
      .where(eq(memberEvents.circleId, circleId))
      .orderBy(asc(memberEvents.epoch)),
    db
      .select({ identityPublicKey: circleMembers.identityPublicKey, name: circleMembers.name })
      .from(circleMembers)
      .where(eq(circleMembers.circleId, circleId)),
  ]);

  const names = new Map(roster.map((member) => [member.identityPublicKey, member.name]));

  return rows
    .map((row) => ({
      id: String(row.id),
      kind: row.kind,
      subjectName: names.get(row.subjectPublicKey) ?? '',
      actorName: names.get(row.actorPublicKey) ?? null,
      selfInflicted: row.actorPublicKey === row.subjectPublicKey,
      subjectPublicKey: row.subjectPublicKey,
      actorPublicKey: row.actorPublicKey,
      role: row.role,
      occurredAt: row.occurredAt,
    }))
    .sort((a, b) => b.occurredAt - a.occurredAt);
}
