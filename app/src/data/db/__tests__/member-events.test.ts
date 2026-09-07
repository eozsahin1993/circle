import { initDatabase } from '@/data/db';
import { insertCircle } from '@/data/db/circles';
import {
  getCircleMemberEvents,
  recordMemberAdded,
  recordMemberAddedLocally,
  recordMemberRemoved,
  recordMemberRemovedLocally,
  recordRoleChanged,
  recordRoleChangedLocally,
  type AddedMemberProfile,
} from '@/data/db/member-events';
import { getCircleMembers, getMemberByPublicKey, MemberRoles } from '@/data/db/members';
import { generateUUID } from '@/services/crypto';

beforeAll(() => initDatabase());

async function makeCircle() {
  const circle = {
    id: generateUUID(),
    name: 'Test Circle',
    picture: null,
    syncId: generateUUID(),
    createdAt: Date.now(),
    leftAt: null,
    metaCursor: 0,
    contentCursor: 0,
    lastViewedAt: 0,
  };
  await insertCircle(circle);
  return circle;
}

function profile(overrides: Partial<AddedMemberProfile> = {}): AddedMemberProfile {
  return {
    encPublicKey: `x25519-${generateUUID()}`,
    memberId: generateUUID(),
    role: MemberRoles.member,
    name: 'Grandma',
    picture: null,
    ...overrides,
  };
}

const key = () => `pk-${generateUUID()}`;

describe('the roster projection', () => {
  test('an add lands a current member', async () => {
    const circle = await makeCircle();
    const subject = key();

    await recordMemberAdded({
      circleId: circle.id,
      epoch: 1,
      subjectPublicKey: subject,
      actorPublicKey: key(),
      occurredAt: 1_000,
      profile: profile({ name: 'Marcus' }),
    });

    const roster = await getCircleMembers(circle.id);
    expect(roster.map((member) => member.name)).toEqual(['Marcus']);
    expect(roster[0].joinedAt).toBe(1_000);
  });

  test('a removal keeps the row but drops them from the roster', async () => {
    const circle = await makeCircle();
    const subject = key();
    await recordMemberAdded({
      circleId: circle.id, epoch: 1, subjectPublicKey: subject, actorPublicKey: key(), occurredAt: 1_000,
      profile: profile(),
    });

    await recordMemberRemoved({
      circleId: circle.id, epoch: 2, subjectPublicKey: subject, actorPublicKey: key(), occurredAt: 5_000,
    });

    expect(await getCircleMembers(circle.id)).toHaveLength(0);
    // Kept so this member's past posts still pass `authoredByMember`.
    expect((await getMemberByPublicKey(circle.id, subject))?.removedAt).toBe(5_000);
  });

  /**
   * The bug the whole table exists to fix: the old
   * `insertMemberIfAbsent` skipped the existing row entirely, so a
   * re-approved member kept their stale `removedAt` and stayed filtered
   * out of `getCircleMembers` forever.
   */
  test('a rejoin revives the row instead of leaving it removed', async () => {
    const circle = await makeCircle();
    const subject = key();
    const admin = key();

    await recordMemberAdded({
      circleId: circle.id, epoch: 1, subjectPublicKey: subject, actorPublicKey: admin, occurredAt: 1_000,
      profile: profile({ name: 'Marcus' }),
    });
    await recordMemberRemoved({
      circleId: circle.id, epoch: 2, subjectPublicKey: subject, actorPublicKey: admin, occurredAt: 2_000,
    });
    await recordMemberAdded({
      circleId: circle.id, epoch: 3, subjectPublicKey: subject, actorPublicKey: admin, occurredAt: 3_000,
      profile: profile({ name: 'Marcus' }),
    });

    const row = await getMemberByPublicKey(circle.id, subject);
    expect(row?.removedAt).toBeNull();
    expect(row?.joinedAt).toBe(3_000);
    expect(await getCircleMembers(circle.id)).toHaveLength(1);
  });

  test('a rejoin keeps the local profile rather than overwriting it with the entry’s copy', async () => {
    const circle = await makeCircle();
    const subject = key();
    const fullResolution = new Uint8Array([1, 2, 3]);

    await recordMemberAddedLocally({ circleId: circle.id, subjectPublicKey: subject, joinedAt: 1_000, profile: profile({ name: 'Marcus Aurelius', picture: fullResolution }) });
    await recordMemberRemoved({
      circleId: circle.id, epoch: 1, subjectPublicKey: subject, actorPublicKey: key(), occurredAt: 2_000,
    });
    await recordMemberAdded({
      circleId: circle.id, epoch: 2, subjectPublicKey: subject, actorPublicKey: key(), occurredAt: 3_000,
      profile: profile({ name: 'Marcus', picture: null }),
    });

    const row = await getMemberByPublicKey(circle.id, subject);
    expect(row?.name).toBe('Marcus Aurelius');
    expect(row?.picture).toEqual(fullResolution);
  });

  test('a role change moves the role', async () => {
    const circle = await makeCircle();
    const subject = key();
    await recordMemberAdded({
      circleId: circle.id, epoch: 1, subjectPublicKey: subject, actorPublicKey: key(), occurredAt: 1_000,
      profile: profile({ role: MemberRoles.member }),
    });

    await recordRoleChanged({
      circleId: circle.id, epoch: 2, subjectPublicKey: subject, actorPublicKey: key(), occurredAt: 2_000,
      role: MemberRoles.admin,
    });

    expect((await getMemberByPublicKey(circle.id, subject))?.role).toBe(MemberRoles.admin);
  });

  test('the local-only writers touch state without authoring history', async () => {
    const circle = await makeCircle();
    const subject = key();

    await recordMemberAddedLocally({ circleId: circle.id, subjectPublicKey: subject, joinedAt: 1_000, profile: profile({ role: MemberRoles.member }) });
    await recordRoleChangedLocally({ circleId: circle.id, subjectPublicKey: subject, role: MemberRoles.admin });

    expect((await getMemberByPublicKey(circle.id, subject))?.role).toBe(MemberRoles.admin);
    // No epoch existed for any of it, so no event row could be keyed —
    // those arrive when the outbox entries are pulled back.
    expect(await getCircleMemberEvents(circle.id)).toHaveLength(0);

    await recordMemberRemovedLocally({ circleId: circle.id, subjectPublicKey: subject, removedAt: 2_000 });
    expect(await getCircleMembers(circle.id)).toHaveLength(0);
    expect(await getCircleMemberEvents(circle.id)).toHaveLength(0);
  });

  test('recordMemberRemovedLocally will not overwrite an earlier removal', async () => {
    const circle = await makeCircle();
    const subject = key();
    await recordMemberAddedLocally({ circleId: circle.id, subjectPublicKey: subject, joinedAt: 1_000, profile: profile() });

    await recordMemberRemovedLocally({ circleId: circle.id, subjectPublicKey: subject, removedAt: 2_000 });
    await recordMemberRemovedLocally({ circleId: circle.id, subjectPublicKey: subject, removedAt: 9_000 });

    expect((await getMemberByPublicKey(circle.id, subject))?.removedAt).toBe(2_000);
  });
});

describe('getCircleMemberEvents', () => {
  test('resolves both sides of an attributed add', async () => {
    const circle = await makeCircle();
    const admin = key();
    const subject = key();
    await recordMemberAdded({
      circleId: circle.id, epoch: 1, subjectPublicKey: admin, actorPublicKey: admin, occurredAt: 1_000,
      profile: profile({ name: 'Nadia', role: MemberRoles.admin }),
    });

    await recordMemberAdded({
      circleId: circle.id, epoch: 2, subjectPublicKey: subject, actorPublicKey: admin, occurredAt: 2_000,
      profile: profile({ name: 'Marcus' }),
    });

    const [newest] = await getCircleMemberEvents(circle.id);
    expect(newest).toMatchObject({
      kind: 'added',
      subjectName: 'Marcus',
      actorName: 'Nadia',
      selfInflicted: false,
      occurredAt: 2_000,
    });
  });

  test('marks an event the subject caused themselves', async () => {
    const circle = await makeCircle();
    const founder = key();

    await recordMemberAdded({
      circleId: circle.id, epoch: 1, subjectPublicKey: founder, actorPublicKey: founder, occurredAt: 1_000,
      profile: profile({ name: 'Nadia', role: MemberRoles.admin }),
    });

    expect((await getCircleMemberEvents(circle.id))[0].selfInflicted).toBe(true);
  });

  test('renders unattributed when this device never saw the actor join', async () => {
    const circle = await makeCircle();
    const subject = key();
    await recordMemberAdded({
      circleId: circle.id, epoch: 1, subjectPublicKey: subject, actorPublicKey: key(), occurredAt: 1_000,
      profile: profile({ name: 'Marcus' }),
    });

    const [event] = await getCircleMemberEvents(circle.id);
    // The line survives without its attribution rather than vanishing.
    expect(event.actorName).toBeNull();
    expect(event.subjectName).toBe('Marcus');
  });

  /** The roster row can only ever hold one join and one removal; the log holds every stint. */
  test('keeps every stint of a rejoin cycle, newest first', async () => {
    const circle = await makeCircle();
    const subject = key();
    const admin = key();

    await recordMemberAdded({
      circleId: circle.id, epoch: 1, subjectPublicKey: subject, actorPublicKey: admin, occurredAt: 1_000,
      profile: profile(),
    });
    await recordMemberRemoved({
      circleId: circle.id, epoch: 2, subjectPublicKey: subject, actorPublicKey: admin, occurredAt: 2_000,
    });
    await recordMemberAdded({
      circleId: circle.id, epoch: 3, subjectPublicKey: subject, actorPublicKey: admin, occurredAt: 3_000,
      profile: profile(),
    });
    await recordMemberRemoved({
      circleId: circle.id, epoch: 4, subjectPublicKey: subject, actorPublicKey: admin, occurredAt: 4_000,
    });

    const events = await getCircleMemberEvents(circle.id);
    expect(events.map((event) => [event.kind, event.occurredAt])).toEqual([
      ['removed', 4_000],
      ['added', 3_000],
      ['removed', 2_000],
      ['added', 1_000],
    ]);
  });

  test('a replayed entry is recorded once', async () => {
    const circle = await makeCircle();
    const event = {
      circleId: circle.id, epoch: 1, subjectPublicKey: key(), actorPublicKey: key(), occurredAt: 1_000,
      profile: profile(),
    };

    await recordMemberAdded(event);
    await recordMemberAdded(event);

    expect(await getCircleMemberEvents(circle.id)).toHaveLength(1);
  });

  test('ignores other circles', async () => {
    const circle = await makeCircle();
    const other = await makeCircle();
    await recordMemberAdded({
      circleId: other.id, epoch: 1, subjectPublicKey: key(), actorPublicKey: key(), occurredAt: 1_000,
      profile: profile({ name: 'Elsewhere' }),
    });

    expect(await getCircleMemberEvents(circle.id)).toHaveLength(0);
  });
});
