import type { MemberEvent, MemberEventKind, MemberRole } from '@/data/db';
import { formatDay } from '@/utils/time';

/**
 * One subject swept into a group — just enough to name them, in the order
 * they were acted on (oldest first, so "and N others" always hides the
 * most recent rather than the first).
 */
export type GroupedSubject = { subjectPublicKey: string; subjectName: string };

/**
 * Every event sharing one day, one actor (or "nobody in particular", for a
 * self-inflicted kind — see `groupKey`), and one action, folded into a
 * single row's worth of subjects.
 */
export type MembershipEventGroup = {
  kind: MemberEventKind;
  role: MemberRole | null;
  selfInflicted: boolean;
  actorPublicKey: string;
  actorName: string | null;
  subjects: GroupedSubject[];
  /** The group's most recent event — decides where its row sorts against posts and other groups. */
  occurredAt: number;
};

/** A day's worth of grouped events — broken up wherever a post intervenes, even within the same day. */
export type MembershipEventBlock = {
  /** `formatDay`'s label for every event in this block — not necessarily unique across blocks, see `groupMemberEvents`. */
  day: string;
  groups: MembershipEventGroup[];
  /** The block's most recent event — decides where its day header sorts. */
  occurredAt: number;
};

/**
 * Turns a flat, newest-first list of roster changes into day blocks of
 * consolidated groups — what the feed actually renders instead of one row
 * per event.
 *
 * A block ends, and a new one starts, wherever the next event either
 * lands on a different calendar day or has a post between it and the
 * previous event — a post breaks up a day's events into two blocks rather
 * than being merged with either. Two blocks can carry the same `day`
 * label this way; that's deliberate, not a bug, since a post is real news
 * that shouldn't read as continuous with what came before it.
 *
 * Both `events` and `postTimestamps` must already be sorted newest-first
 * (what `getCircleMemberEvents` and `getCircleFeed` both return) — this
 * never re-sorts either, so a caller with a different order gets nonsense
 * blocks silently rather than a clear failure.
 */
export function groupMemberEvents(events: MemberEvent[], postTimestamps: number[]): MembershipEventBlock[] {
  // A single forward pointer into `postTimestamps`, walked alongside
  // `events` — O(events + posts) instead of rescanning every post per event.
  let postIndex = 0;

  const blocks: MembershipEventBlock[] = [];
  let current: MemberEvent[] = [];

  const flush = () => {
    if (current.length > 0) blocks.push(buildBlock(current));
    current = [];
  };

  for (const event of events) {
    const previous = current[current.length - 1];
    if (previous !== undefined) {
      // Posts at or after `previous` were already ruled out (by this
      // check or an earlier one) and can never matter again — every
      // event from here on is older still.
      while (postIndex < postTimestamps.length && postTimestamps[postIndex] >= previous.occurredAt) postIndex++;
      const postBetween = postIndex < postTimestamps.length && postTimestamps[postIndex] > event.occurredAt;
      if (formatDay(event.occurredAt) !== formatDay(previous.occurredAt) || postBetween) flush();
    }
    current.push(event);
  }
  flush();

  return blocks;
}

function buildBlock(events: MemberEvent[]): MembershipEventBlock {
  const groups = new Map<string, MembershipEventGroup>();
  const order: string[] = [];

  // Newest-first, same as `events` — so the first event seen for a given
  // key is that group's most recent, and `order` ends up newest-group-first.
  for (const event of events) {
    const key = groupKey(event);
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: event.kind,
        role: event.role,
        selfInflicted: event.selfInflicted,
        actorPublicKey: event.actorPublicKey,
        actorName: event.actorName,
        subjects: [],
        occurredAt: event.occurredAt,
      };
      groups.set(key, group);
      order.push(key);
    }
    // Pushed newest-first here too; reversed below once every event in
    // this block has been seen.
    group.subjects.push({ subjectPublicKey: event.subjectPublicKey, subjectName: event.subjectName });
  }
  for (const key of order) groups.get(key)!.subjects.reverse();

  return { day: formatDay(events[0].occurredAt), groups: order.map((key) => groups.get(key)!), occurredAt: events[0].occurredAt };
}

/**
 * What makes two events "the same action" — actor, kind, and role
 * (`role_changed` only, so a promotion never merges with a demotion).
 *
 * Self-inflicted events (today: only leaving) drop the actor from the
 * key entirely rather than using it as-is. The actor *is* the subject for
 * these, so keying on it would mean every departure has a different
 * "actor" and none of them would ever merge with each other — the
 * opposite of what grouping several people leaving the same day is for.
 */
function groupKey(event: MemberEvent): string {
  const actor = event.selfInflicted ? 'self' : event.actorPublicKey;
  return `${actor}\0${event.kind}\0${event.role ?? ''}`;
}
