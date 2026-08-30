import { generateCircleId, generateMemberId } from '@/lib/crypto';
import { initDatabase } from '@/lib/db';
import { insertCircle } from '@/lib/db/circles';
import {
  deleteMember,
  getCircleMembers,
  getMemberByMemberId,
  getMemberByPublicKey,
  insertMember,
  updateMemberProfile,
} from '@/lib/db/members';

beforeAll(() => initDatabase());

async function makeCircle() {
  const circle = { id: generateCircleId(), name: 'Test Circle', createdAt: Date.now() };
  await insertCircle(circle);
  return circle;
}

function makeMember(circleId: string, overrides: Partial<{ name: string; joinedAt: number }> = {}) {
  return {
    circleId,
    publicKey: `pk-${generateMemberId()}`,
    memberId: generateMemberId(),
    name: overrides.name ?? 'Grandma',
    picture: null,
    joinedAt: overrides.joinedAt ?? Date.now(),
  };
}

describe('members CRUD', () => {
  test('insertMember then getMemberByPublicKey returns the same row', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    await expect(getMemberByPublicKey(circle.id, member.publicKey)).resolves.toEqual(member);
  });

  test('getMemberByMemberId resolves the same row via the compact reference', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    await expect(getMemberByMemberId(circle.id, member.memberId)).resolves.toEqual(member);
  });

  test('a duplicate (circleId, publicKey) pair is rejected by the composite primary key', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    await expect(insertMember({ ...member, memberId: generateMemberId() })).rejects.toThrow();
  });

  test('getCircleMembers returns every member of a circle, ordered by joinedAt', async () => {
    const circle = await makeCircle();
    const earlier = makeMember(circle.id, { name: 'Earlier', joinedAt: 1000 });
    const later = makeMember(circle.id, { name: 'Later', joinedAt: 2000 });
    await insertMember(later);
    await insertMember(earlier);

    const roster = await getCircleMembers(circle.id);
    const ids = roster.map((m) => m.publicKey);
    expect(ids.indexOf(earlier.publicKey)).toBeLessThan(ids.indexOf(later.publicKey));
  });

  test('updateMemberProfile changes name and picture', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    const picture = new Uint8Array([1, 2, 3]);
    await updateMemberProfile(circle.id, member.publicKey, { name: 'New Name', picture });

    const updated = await getMemberByPublicKey(circle.id, member.publicKey);
    expect(updated?.name).toBe('New Name');
    expect(updated?.picture).toEqual(picture);
  });

  test('deleteMember removes the row', async () => {
    const circle = await makeCircle();
    const member = makeMember(circle.id);
    await insertMember(member);

    await deleteMember(circle.id, member.publicKey);

    await expect(getMemberByPublicKey(circle.id, member.publicKey)).resolves.toBeNull();
  });
});
