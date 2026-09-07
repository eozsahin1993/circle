import { useMemo } from 'react';

import type { FeedRow, FeedRows } from '@/components/feed/rows';
import { formatDay } from '@/utils/time';
import { MembershipEventRow } from '@/components/membership-event-row';
import { Spacing } from '@/constants/theme';
import type { MemberEvent } from '@/data/db';

/**
 * Someone joined, left, or changed role. Takes no actions at all — there
 * is nothing to do to it — which is why row modules take their own
 * dependencies rather than one shared bag of every handler in the feed.
 *
 * A rule across the feed rather than a card, so it asks for a tighter
 * gap, which `gapBetween` then applies on both its sides.
 */
export type RosterChangeRowsInput = {
  events: MemberEvent[];
  /** This device's identity, so a line about the reader reads in the second person. */
  ownPublicKey: string | null;
};

/** Takes no actions — there is nothing to do to a roster change. */
export function useRosterChangeRows({ events, ownPublicKey }: RosterChangeRowsInput): FeedRows {
  return useMemo(
    () => ({ rows: events.map((event) => rosterChangeRow(event, ownPublicKey)) }),
    [events, ownPublicKey],
  );
}

export function rosterChangeRow(event: MemberEvent, ownPublicKey: string | null): FeedRow {
  const item = {
    id: event.id,
    kind: event.kind,
    // Blank only in the window between an event row landing and the roster
    // write behind it (see member-events.ts) — the next replay fills it in.
    subjectName: event.subjectName || 'Someone',
    actorName: event.actorName,
    selfInflicted: event.selfInflicted,
    subjectIsYou: event.subjectPublicKey === ownPublicKey,
    actorIsYou: event.actorPublicKey === ownPublicKey,
    role: event.role,
    timestamp: formatDay(event.occurredAt),
  };

  return {
    key: event.id,
    spacing: Spacing.gapAroundMemberEvent,
    at: event.occurredAt,
    render: () => <MembershipEventRow event={item} />,
  };
}
