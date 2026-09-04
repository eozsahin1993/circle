import { generateUUID } from '@/services/crypto';
import { initDatabase } from '@/data/db';
import { insertCircle } from '@/data/db/circles';
import {
  getCircleMembers,
  getMemberByMemberId,
  getMemberByPublicKey,
  insertMember,
  markMemberRemoved,
  MemberRole,
  MemberRoles,
  updateMemberProfile,
} from '@/data/db/members';

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
  };
  await insertCircle(circle);
  return circle;
}

function makeMember(
  circleId: string,
  overrides: Partial<{ name: string; role: MemberRole; joinedAt: number }> = {},
) {
  return {
    circleId,
    identityPublicKey: `pk-${generateUUID()}`,
    encPublicKey: `x25519-${generateUUID()}`,
    memberId: generateUUID(),
    role: overrides.role ?? MemberRoles.member,
    name: overrides.name ?? 'Grandma',
    picture: null,
    joinedAt: overrides.joinedAt ?? Date.now(),
    removedAt: null,
  };
}

describe('members CRUD', () => {
  test('insertMember then getMemberByPublicKey returns the same row', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    await expect(getMemberByPublicKey(circle.id, member.identityPublicKey)).resolves.toEqual(member);
  });

  test('getMemberByMemberId resolves the same row via the compact reference', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    await expect(getMemberByMemberId(circle.id, member.memberId)).resolves.toEqual(member);
  });

  test('a duplicate (circleId, identityPublicKey) pair is rejected by the composite primary key', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    await expect(insertMember({ ...member, memberId: generateUUID() })).rejects.toThrow();
  });

  test('getCircleMembers returns every member of a circle, ordered by joinedAt', async () => {
    const circle = await makeCircle();
    const earlier = makeMember(circle.id, { name: 'Earlier', joinedAt: 1000 });
    const later = makeMember(circle.id, { name: 'Later', joinedAt: 2000 });
    await insertMember(later);
    await insertMember(earlier);

    const roster = await getCircleMembers(circle.id);
    const ids = roster.map((m) => m.identityPublicKey);
    expect(ids.indexOf(earlier.identityPublicKey)).toBeLessThan(ids.indexOf(later.identityPublicKey));
  });

  test('updateMemberProfile changes name and picture', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    const picture = new Uint8Array([1, 2, 3]);
    await updateMemberProfile(circle.id, member.identityPublicKey, { name: 'New Name', picture });

    const updated = await getMemberByPublicKey(circle.id, member.identityPublicKey);
    expect(updated?.name).toBe('New Name');
    expect(updated?.picture).toEqual(picture);
  });

  test('markMemberRemoved sets removedAt but keeps the row', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    await markMemberRemoved(circle.id, member.identityPublicKey);

    const row = await getMemberByPublicKey(circle.id, member.identityPublicKey);
    expect(row?.removedAt).not.toBeNull();
  });

  test('markMemberRemoved excludes the member from getCircleMembers', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    await markMemberRemoved(circle.id, member.identityPublicKey);

    const roster = await getCircleMembers(circle.id);
    expect(roster.find((m) => m.identityPublicKey === member.identityPublicKey)).toBeUndefined();
  });
});
