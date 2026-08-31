import { generateUUID } from '@/lib/crypto';
import { initDatabase } from '@/lib/db';
import { deleteCircle, getAllCircles, getCircle, insertCircle, updateCircleName } from '@/lib/db/circles';
import { getMemberByPublicKey, insertMember } from '@/lib/db/members';

beforeAll(() => initDatabase());

function makeCircle(overrides: Partial<{ id: string; name: string; createdAt: number }> = {}) {
  return {
    id: generateUUID(),
    name: 'Nana’s House',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('circles CRUD', () => {
  test('insertCircle then getCircle returns the same row', async () => {
    const circle = makeCircle();
    await insertCircle(circle);

    await expect(getCircle(circle.id)).resolves.toEqual(circle);
  });

  test('getCircle returns null for an unknown id', async () => {
    await expect(getCircle(generateUUID())).resolves.toBeNull();
  });

  test('getAllCircles returns every inserted circle, ordered by createdAt', async () => {
    const earlier = makeCircle({ name: 'Earlier', createdAt: 1000 });
    const later = makeCircle({ name: 'Later', createdAt: 2000 });
    await insertCircle(later);
    await insertCircle(earlier);

    const all = await getAllCircles();
    const ids = all.map((c) => c.id);
    expect(ids.indexOf(earlier.id)).toBeLessThan(ids.indexOf(later.id));
  });

  test('updateCircleName changes the stored name', async () => {
    const circle = makeCircle();
    await insertCircle(circle);

    await updateCircleName(circle.id, 'The Andersons');

    await expect(getCircle(circle.id)).resolves.toMatchObject({ name: 'The Andersons' });
  });

  test('deleteCircle removes the row', async () => {
    const circle = makeCircle();
    await insertCircle(circle);

    await deleteCircle(circle.id);

    await expect(getCircle(circle.id)).resolves.toBeNull();
  });

  test('deleting a circle cascades to its members (validates ON DELETE CASCADE + foreign_keys pragma)', async () => {
    const circle = makeCircle();
    await insertCircle(circle);
    const member = {
      circleId: circle.id,
      publicKey: 'aa'.repeat(32),
      memberId: 'bb'.repeat(16),
      name: 'Grandma',
      picture: null,
      joinedAt: Date.now(),
    };
    await insertMember(member);

    await deleteCircle(circle.id);

    await expect(getMemberByPublicKey(circle.id, member.publicKey)).resolves.toBeNull();
  });
});
