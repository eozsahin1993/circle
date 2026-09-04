jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/mailbox-relay');
jest.mock('@/services/relay');

import { Buffer } from 'buffer';

import { initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import {
  approveJoinRequest,
  denyJoinRequest,
  discoverPendingRequests,
  getOrCreateInvite,
} from '@/domain/usecases/circle/invite-to-circle';
import type { JoinRequestPayload } from '@/domain/usecases/circle/invite-payloads';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { deriveInviteTag, deriveJoinRequestKey, encryptJSON, generateEphemeralKeypair } from '@/services/crypto';
import { bytesToHex } from '@noble/curves/utils.js';
import { deleteJoinRequest, listJoinRequests, putInvitePreview } from '@/services/mailbox-relay';
import { saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.clearAllMocks();
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
  (putInvitePreview as jest.Mock).mockResolvedValue(undefined);
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
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

test('discoverPendingRequests decodes the self-reported name, picture, and createdAt', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const invite = await getOrCreateInvite(circleId);

  const key = deriveJoinRequestKey(invite.code);
  const { publicKey } = generateEphemeralKeypair();
  const payload: JoinRequestPayload = {
    ephemeralPublicKey: bytesToHex(publicKey),
    identityPublicKey: 'aa'.repeat(32),
    encPublicKey: 'bb'.repeat(32),
    selfReportedName: 'Priya Raman',
    pictureThumbnail: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64'),
  };
  const createdAt = Date.now();
  (listJoinRequests as jest.Mock).mockResolvedValue([
    { requesterId: 'req-1', encryptedRequest: encryptJSON(payload, key), createdAt },
  ]);

  const requests = await discoverPendingRequests(circleId);

  expect(requests).toEqual([
    {
      requesterId: 'req-1',
      selfReportedName: 'Priya Raman',
      pictureUri: expect.stringContaining('data:image/jpeg;base64,'),
      createdAt,
    },
  ]);
});

test('discoverPendingRequests omits pictureUri when the requester sent no picture', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const invite = await getOrCreateInvite(circleId);

  const key = deriveJoinRequestKey(invite.code);
  const { publicKey } = generateEphemeralKeypair();
  const payload: JoinRequestPayload = {
    ephemeralPublicKey: bytesToHex(publicKey),
    identityPublicKey: 'aa'.repeat(32),
    encPublicKey: 'bb'.repeat(32),
    selfReportedName: 'Tomás Ruiz',
  };
  (listJoinRequests as jest.Mock).mockResolvedValue([
    { requesterId: 'req-2', encryptedRequest: encryptJSON(payload, key), createdAt: Date.now() },
  ]);

  const [request] = await discoverPendingRequests(circleId);

  expect(request.pictureUri).toBeUndefined();
});

test('discoverPendingRequests excludes a request that already has an approval', async () => {
  // Regression test: approveJoinRequest updates the mailbox row in place
  // rather than deleting it (the requester still needs to poll and read
  // the approval), so discoverPendingRequests must filter these out
  // itself — otherwise an already-approved request keeps reappearing on
  // every refetch (e.g. navigating back to the invite/feed screen), even
  // though there's nothing left for the creator to do with it.
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const invite = await getOrCreateInvite(circleId);

  const key = deriveJoinRequestKey(invite.code);
  const { publicKey } = generateEphemeralKeypair();
  const payload: JoinRequestPayload = {
    ephemeralPublicKey: bytesToHex(publicKey),
    identityPublicKey: 'aa'.repeat(32),
    encPublicKey: 'bb'.repeat(32),
    selfReportedName: 'Priya Raman',
  };
  (listJoinRequests as jest.Mock).mockResolvedValue([
    {
      requesterId: 'req-1',
      encryptedRequest: encryptJSON(payload, key),
      encryptedApproval: new Uint8Array([1, 2, 3]),
      createdAt: Date.now(),
    },
  ]);

  await expect(discoverPendingRequests(circleId)).resolves.toEqual([]);
});

test('denyJoinRequest deletes the mailbox row for the circle this device created the invite for', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const invite = await getOrCreateInvite(circleId);
  (deleteJoinRequest as jest.Mock).mockResolvedValue(undefined);

  await denyJoinRequest(circleId, 'req-1');

  expect(deleteJoinRequest).toHaveBeenCalledWith(deriveInviteTag(invite.code), 'req-1');
});

test('denyJoinRequest throws for a device with no identity in the circle', async () => {
  await expect(denyJoinRequest('not-a-real-circle-id', 'some-requester')).rejects.toThrow();
});
