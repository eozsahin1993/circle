jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/mailbox-relay');

import { initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { discoverPendingRequests, approveJoinRequest, getOrCreateInvite } from '@/domain/usecases/circle/invite-to-circle';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { putInvitePreview } from '@/services/mailbox-relay';
import { saveMasterSeed } from '@/services/keystore';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.clearAllMocks();
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (putInvitePreview as jest.Mock).mockResolvedValue(undefined);
});

test('getOrCreateInvite writes the server-side preview row alongside the local invite', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  const invite = await getOrCreateInvite(circleId);

  expect(putInvitePreview).toHaveBeenCalledWith(expect.any(String), expect.any(Uint8Array));
  expect(invite.circleId).toBe(circleId);
});

test('a failed preview write surfaces as a rejection, not a silently-broken invite', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  (putInvitePreview as jest.Mock).mockRejectedValue(new Error('offline'));

  await expect(getOrCreateInvite(circleId)).rejects.toThrow('offline');
});

test('discoverPendingRequests throws for a device with no identity in the circle', async () => {
  await expect(discoverPendingRequests('not-a-real-circle-id')).rejects.toThrow();
});

test('approveJoinRequest throws for a device with no identity in the circle', async () => {
  await expect(approveJoinRequest('not-a-real-circle-id', 'some-requester')).rejects.toThrow();
});
