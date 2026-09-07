import { justJoinedRow } from '@/components/feed/just-joined-row';
import { pendingRequestRow } from '@/components/feed/pending-request-row';
import { privacyRow } from '@/components/feed/privacy-row';
import { rosterChangeRow } from '@/components/feed/roster-change-row';
import { buildFeedRows, gapBetween, stickyIndices, type FeedRow } from '@/components/feed/rows';
import { Spacing } from '@/constants/theme';
import type { MemberEvent } from '@/data/db';


function event(id: string, occurredAt: number): MemberEvent {
  return {
    id,
    kind: 'added',
    subjectName: 'Marcus',
    actorName: 'Nadia',
    selfInflicted: false,
    subjectPublicKey: 'pk-subject',
    actorPublicKey: 'pk-actor',
    role: 'member',
    occurredAt,
  };
}

const noRequestActions = { busy: false, onApprove: () => {}, onDeny: () => {} };

/** The same mapping `useCircleFeed` performs, with the row kinds it has today. */
function build(events: MemberEvent[] = [], justJoined = false): FeedRow[] {
  return buildFeedRows([
    pendingRequestRow({ requesterId: 'a', selfReportedName: 'Marcus', createdAt: 1 }, noRequestActions),
    privacyRow(() => {}),
    ...(justJoined ? [justJoinedRow()] : []),
    ...events.map((event) => rosterChangeRow(event, null)),
  ]);
}

describe('buildFeedRows', () => {
  test('pins in adapter order, above the timeline', () => {
    expect(build([event('e1', 1_000)]).map((row) => row.key)).toEqual(['request:a', 'privacy', 'e1']);
  });

  /** Pinned rows are about the circle now, not about a moment, so they never sort. */
  test('sorts only the timeline, newest first', () => {
    const rows = build([event('old', 1_000), event('new', 3_000), event('mid', 2_000)]);

    expect(rows.map((row) => row.key)).toEqual(['request:a', 'privacy', 'new', 'mid', 'old']);
  });

  /** Ordering only — it renders exactly the rows it is handed. */
  test('renders exactly the rows it is given', () => {
    expect(buildFeedRows([rosterChangeRow(event('e1', 1_000), null)]).map((row) => row.key)).toEqual(['e1']);
  });
});

describe('each row decides for itself', () => {
  test('a join request sticks; a roster change does not', () => {
    expect(pendingRequestRow({ requesterId: 'a', selfReportedName: 'M', createdAt: 1 }, noRequestActions).sticky).toBe(true);
    expect(rosterChangeRow(event('e1', 1), null).sticky).toBeUndefined();
  });

  test('only a timeline row carries a time', () => {
    expect(rosterChangeRow(event('e1', 5_000), null).at).toBe(5_000);
    expect(privacyRow(() => {}).at).toBeUndefined();
  });

  /** A roster change means nothing by being scrolled past; a post marks its comments seen. */
  test('a roster change has nothing to mark seen', () => {
    expect(rosterChangeRow(event('e1', 1), null).onSeen).toBeUndefined();
  });

  test('a roster change asks for a tighter gap than a card', () => {
    expect(rosterChangeRow(event('e1', 1), null).spacing).toBe(Spacing.gapAroundMemberEvent);
    expect(privacyRow(() => {}).spacing).toBe(Spacing.gapBetweenPosts);
  });
});

describe('gapBetween', () => {
  const post: FeedRow = { key: 'p', spacing: Spacing.gapBetweenPosts, render: () => null! };
  const rosterChange: FeedRow = { key: 'e', spacing: Spacing.gapAroundMemberEvent, render: () => null! };

  test('two cards take the full gap', () => {
    expect(gapBetween(post, post)).toBe(Spacing.gapBetweenPosts);
  });

  /** The quieter row wins, so it tightens both its sides without either neighbour knowing about it. */
  test.each([
    ['before', post, rosterChange],
    ['after', rosterChange, post],
  ])('a roster change tightens the gap %s it', (_label, leading, trailing) => {
    expect(gapBetween(leading, trailing)).toBe(Spacing.gapAroundMemberEvent);
  });

  test('the last row falls back to its own spacing', () => {
    expect(gapBetween(rosterChange, undefined)).toBe(Spacing.gapAroundMemberEvent);
  });
});

describe('stickyIndices', () => {
  const pinned: FeedRow = { key: 'p', spacing: 0, sticky: true, render: () => null! };
  const ordinary: FeedRow = { key: 'o', spacing: 0, render: () => null! };

  /** FlatList counts ListHeaderComponent as index 0, so data rows sit one further along. */
  test('offsets by the header, which is always sticky', () => {
    expect(stickyIndices([pinned, pinned, ordinary])).toEqual([0, 1, 2]);
  });

  test('is just the header when nothing else sticks', () => {
    expect(stickyIndices([ordinary])).toEqual([0]);
  });
});
