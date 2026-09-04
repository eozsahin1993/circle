jest.mock('@/services/relay');

import { hexToBytes } from '@noble/curves/utils.js';

import { decrypt, deriveAuthorityKeypair, deriveCoverPhotoUploadMessage, deriveWriteToken, hashBytes, verify } from '@/services/crypto';
import { getCurrentContentKey, getMasterSeed, saveMasterSeed } from '@/services/keystore';
import { getCircle, initDatabase } from '@/data/db';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { setCoverPhoto } from '@/domain/usecases/circle/set-cover-photo';
import { appendEntry, getCoverPhotoUploadTarget, uploadBlob } from '@/services/relay';

const uploadTarget = { url: 'https://s3/bucket', fields: { key: 'sync-a/cover' } };

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * Also clears the mocks right after creation — `createCircle` itself
 * calls `bootstrapCircle`/`appendEntry` internally (for the founder's own
 * `member_added` entry), and every test below asserts on `setCoverPhoto`'s
 * *own* relay calls specifically, not that unrelated setup call.
 */
async function makeCircle() {
  const { id: circleId } = await createCircle({ name: 'Test Circle' });
  jest.clearAllMocks();
  (getCoverPhotoUploadTarget as jest.Mock).mockResolvedValue(uploadTarget);
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  return circleId;
}

test('setCoverPhoto requests an upload target signed by the derived authority keypair', async () => {
  const circleId = await makeCircle();
  const circle = (await getCircle(circleId))!;
  const masterSeed = (await getMasterSeed())!;
  const authorityKeypair = deriveAuthorityKeypair(masterSeed, circleId);
  const current = (await getCurrentContentKey(circleId))!;

  await setCoverPhoto(circleId, new Uint8Array([1, 2, 3]));

  expect(getCoverPhotoUploadTarget).toHaveBeenCalledTimes(1);
  const [syncId, writeToken, authorityPublicKey, signature] = (getCoverPhotoUploadTarget as jest.Mock).mock.calls[0];
  expect(syncId).toBe(circle.syncId);
  expect(writeToken).toEqual(deriveWriteToken(current.key));
  expect(authorityPublicKey).toEqual(authorityKeypair.publicKey);
  expect(verify(signature, deriveCoverPhotoUploadMessage(circle.syncId), authorityKeypair.publicKey)).toBe(true);
});

test('setCoverPhoto uploads the photo encrypted under the current content key', async () => {
  const circleId = await makeCircle();
  const current = (await getCurrentContentKey(circleId))!;
  const photo = new Uint8Array([9, 8, 7, 6]);

  await setCoverPhoto(circleId, photo);

  expect(uploadBlob).toHaveBeenCalledWith(uploadTarget, expect.anything());
  const [, encryptedPhoto] = (uploadBlob as jest.Mock).mock.calls[0];
  expect(decrypt(encryptedPhoto, current.key)).toEqual(photo);
});

test('setCoverPhoto appends a signed, verifiable cover_photo_set meta entry', async () => {
  const circleId = await makeCircle();
  const circle = (await getCircle(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;
  const photo = new Uint8Array([9, 8, 7, 6]);

  await setCoverPhoto(circleId, photo);

  expect(appendEntry).toHaveBeenCalledTimes(1);
  const [syncId, namespace, , encryptedMeta, keyVersion, writeToken] = (appendEntry as jest.Mock).mock.calls[0];
  expect(syncId).toBe(circle.syncId);
  expect(namespace).toBe('meta');
  expect(keyVersion).toBe(current.version);
  expect(writeToken).toEqual(deriveWriteToken(current.key));

  const envelope = JSON.parse(new TextDecoder().decode(decrypt(encryptedMeta, current.key)));
  expect(envelope.type).toBe('cover_photo_set');
  expect(envelope.payload).toEqual({ photoHash: hashBytes(photo), keyVersion: current.version });
  const verified = verify(
    hexToBytes(envelope.signature),
    new TextEncoder().encode(JSON.stringify({ type: envelope.type, payload: envelope.payload })),
    hexToBytes(envelope.authorPubkey)
  );
  expect(verified).toBe(true);
});

test('setCoverPhoto updates the local circle row so this device sees its own write immediately', async () => {
  const circleId = await makeCircle();
  const photo = new Uint8Array([1, 2, 3]);

  await setCoverPhoto(circleId, photo);

  const circle = await getCircle(circleId);
  expect(circle?.picture).toEqual(photo);
});

test('setCoverPhoto throws without a local circle for this id', async () => {
  await expect(setCoverPhoto('unknown-circle-id', new Uint8Array([1]))).rejects.toThrow();
});
