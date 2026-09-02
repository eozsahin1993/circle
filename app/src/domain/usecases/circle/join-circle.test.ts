jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/mailbox-relay');
jest.mock('@/services/image');

import { Buffer } from 'buffer';

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { getCircle, getCircleMembers, getPendingJoinRequest, initDatabase, saveProfile } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { approveJoinRequest, getOrCreateInvite } from '@/domain/usecases/circle/invite-to-circle';
import type { JoinApprovalEnvelope, JoinApprovalPayload, JoinRequestPayload } from '@/domain/usecases/circle/invite-payloads';
import { checkPendingJoinRequest, requestToJoin } from '@/domain/usecases/circle/join-circle';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { decrypt, deriveJoinRequestKey, generateIdentity, sealToPublicKey, sign } from '@/services/crypto';
import { compressToThumbnail } from '@/services/image';
import {
  getInvitePreview,
  getJoinRequestApproval,
  listJoinRequests,
  putInvitePreview,
  putJoinApproval,
  putJoinRequest,
} from '@/services/mailbox-relay';
import { getCircleSecret, saveMasterSeed } from '@/services/keystore';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.clearAllMocks();
  (drainOutbox as jest.Mock).mockResolvedValue(undefined);
});

/**
 * Creates a circle and its invite, capturing exactly what the creator's
 * device published to the mailbox — then wires `getInvitePreview` to hand
 * that same blob back, simulating the relay for a single-process test
 * where "creator" and "requester" run in the same test but never share
 * state except through these mocked relay calls.
 */
async function makeCircleWithInvite(name: string) {
  const { id: circleId } = await createCircle({ name });
  (putInvitePreview as jest.Mock).mockResolvedValue(undefined);
  const invite = await getOrCreateInvite(circleId);

  const [, previewBlob] = (putInvitePreview as jest.Mock).mock.calls[0];
  (getInvitePreview as jest.Mock).mockResolvedValue(previewBlob);

  return { circleId, invite };
}

test('requestToJoin then approveJoinRequest then checkPendingJoinRequest completes the join end to end', async () => {
  const { circleId: creatorCircleId, invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);

  const { requestId } = await requestToJoin(invite.code);

  // Wire listJoinRequests (creator's "discover") to return exactly what
  // the requester just published — the same one-mocked-module trick as
  // the preview above.
  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  (listJoinRequests as jest.Mock).mockResolvedValue([
    { requesterId: requestId, encryptedRequest: requestBlob, encryptedApproval: null, createdAt: Date.now() },
  ]);
  (putJoinApproval as jest.Mock).mockResolvedValue(undefined);

  await approveJoinRequest(creatorCircleId, requestId);

  // Wire getJoinRequestApproval (requester's "poll") to return exactly
  // what the creator just sealed.
  const [, , approvalBlob] = (putJoinApproval as jest.Mock).mock.calls[0];
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(approvalBlob);

  const result = await checkPendingJoinRequest(requestId);

  expect(result.joined).toBe(true);
  if (!result.joined) throw new Error('unreachable');

  const members = await getCircleMembers(result.circleId);
  expect(members).toHaveLength(1);
  expect(members[0].role).toBe('member');

  await expect(getCircle(result.circleId)).resolves.toMatchObject({ name: 'Family Circle' });
  await expect(getPendingJoinRequest(requestId)).resolves.toBeNull();
  expect(drainOutbox).toHaveBeenCalledWith(result.circleId);
});

test('requestToJoin compresses the profile picture into a thumbnail and includes it in the join request', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  await saveProfile({ name: 'Priya Raman', picture: new Uint8Array([9, 9, 9]), createdAt: Date.now(), updatedAt: Date.now() });
  const thumbnail = new Uint8Array([1, 2, 3]);
  (compressToThumbnail as jest.Mock).mockResolvedValue(thumbnail);
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);

  await requestToJoin(invite.code);

  expect(compressToThumbnail).toHaveBeenCalledWith(new Uint8Array([9, 9, 9]));
  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  const key = deriveJoinRequestKey(invite.code);
  const request = JSON.parse(new TextDecoder().decode(decrypt(requestBlob, key))) as JoinRequestPayload;
  expect(request.pictureThumbnail).toBe(Buffer.from(thumbnail).toString('base64'));
});

test('requestToJoin omits pictureThumbnail when the profile has no picture', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  await saveProfile({ name: 'Tomás Ruiz', picture: null, createdAt: Date.now(), updatedAt: Date.now() });
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);

  await requestToJoin(invite.code);

  expect(compressToThumbnail).not.toHaveBeenCalled();
  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  const key = deriveJoinRequestKey(invite.code);
  const request = JSON.parse(new TextDecoder().decode(decrypt(requestBlob, key))) as JoinRequestPayload;
  expect(request.pictureThumbnail).toBeUndefined();
});

test('requestToJoin still submits the request when thumbnail compression fails', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  await saveProfile({ name: 'Priya Raman', picture: new Uint8Array([9, 9, 9]), createdAt: Date.now(), updatedAt: Date.now() });
  (compressToThumbnail as jest.Mock).mockRejectedValue(new Error('unsupported image format'));
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);

  await expect(requestToJoin(invite.code)).resolves.toEqual({ requestId: expect.any(String) });

  const [, , requestBlob] = (putJoinRequest as jest.Mock).mock.calls[0];
  const key = deriveJoinRequestKey(invite.code);
  const request = JSON.parse(new TextDecoder().decode(decrypt(requestBlob, key))) as JoinRequestPayload;
  expect(request.pictureThumbnail).toBeUndefined();
});

test('requestToJoin throws a clear error when the invite has no preview (bad code, or expired)', async () => {
  (getInvitePreview as jest.Mock).mockResolvedValue(null);

  await expect(requestToJoin('BOGUS-CODE-0000')).rejects.toThrow(/invalid|expired/);
  expect(putJoinRequest).not.toHaveBeenCalled();
});

test('checkPendingJoinRequest returns not-joined for an unknown request id', async () => {
  await expect(checkPendingJoinRequest('unknown-request-id')).resolves.toEqual({ joined: false });
});

test('checkPendingJoinRequest returns not-joined while the approval is still pending', async () => {
  const { invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  const { requestId } = await requestToJoin(invite.code);
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(null);

  await expect(checkPendingJoinRequest(requestId)).resolves.toEqual({ joined: false });
});

test('an approval signed by anyone other than the invite creator is rejected, even carrying the real circle secret', async () => {
  // Simulates a rogue existing member: knows the real circle secret (every
  // member does) and, via the invite code, the requester's real ephemeral
  // public key too — but signs with its own circle identity, not the
  // creator's. The seal itself is valid (correctly encrypted to the real
  // requester), so only the signature check can catch this.
  const { circleId, invite } = await makeCircleWithInvite('Family Circle');
  (putJoinRequest as jest.Mock).mockResolvedValue(undefined);
  const { requestId } = await requestToJoin(invite.code);
  const pending = await getPendingJoinRequest(requestId);
  const realSecret = (await getCircleSecret(circleId))!;
  const rogueIdentity = generateIdentity();

  const approval: JoinApprovalPayload = { secret: bytesToHex(realSecret), circleName: 'Family Circle' };
  const signature = sign(new TextEncoder().encode(JSON.stringify(approval)), rogueIdentity.secretKey);
  const envelope: JoinApprovalEnvelope = { approval, signature: bytesToHex(signature) };
  const forgedSealed = sealToPublicKey(new TextEncoder().encode(JSON.stringify(envelope)), hexToBytes(pending!.ephemeralPublicKey));
  (getJoinRequestApproval as jest.Mock).mockResolvedValue(forgedSealed);

  await expect(checkPendingJoinRequest(requestId)).resolves.toEqual({ joined: false });
  // The pending row survives a rejected forgery, so a later legitimate approval can still land.
  await expect(getPendingJoinRequest(requestId)).resolves.not.toBeNull();
});
