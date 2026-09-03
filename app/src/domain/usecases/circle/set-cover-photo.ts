import { deriveAuthorityKeypair, deriveCoverPhotoUploadMessage, deriveWriteToken, encrypt, generateUUID, hashBytes, sign } from '@/services/crypto';
import { getCircle, updateCirclePicture } from '@/data/db';
import { buildAndEncryptLogEntry } from '@/domain/usecases/circle/log-entry';
import { isCircleAdmin } from '@/domain/usecases/circle/invite-to-circle';
import { getCircleIdentity, getCurrentContentKey, getMasterSeed } from '@/services/keystore';
import { appendEntry, getCoverPhotoUploadTarget, uploadBlob } from '@/services/relay';

/**
 * Sets (or replaces) a circle's cover photo — admin-only. Two relay calls,
 * not one: `getCoverPhotoUploadTarget` is dual-gated (write token *and*
 * an authority signature, since the object it points at is a fixed,
 * always-overwritable key with no per-upload existence check — see
 * services/relay.ts's doc comment on it), then a `cover_photo_set` meta
 * entry carrying `photoHash` records the change so synced devices know to
 * refetch it. Updates this device's own local `circles.picture` directly
 * afterward — no need to round-trip through the relay to see its own
 * write.
 */
export async function setCoverPhoto(circleId: string, photo: Uint8Array): Promise<void> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('No local circle row for this id.');
  if (!(await isCircleAdmin(circleId))) throw new Error('Only an admin can set the cover photo.');

  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const authorityKeypair = deriveAuthorityKeypair(masterSeed, circleId);
  const writeToken = deriveWriteToken(current.key);

  const signature = sign(deriveCoverPhotoUploadMessage(circle.syncId), authorityKeypair.secretKey);
  const target = await getCoverPhotoUploadTarget(circle.syncId, writeToken, authorityKeypair.publicKey, signature);
  await uploadBlob(target, encrypt(photo, current.key));

  const entry = buildAndEncryptLogEntry('cover_photo_set', { photoHash: hashBytes(photo), keyVersion: current.version }, identity, current.key);
  await appendEntry(circle.syncId, 'meta', generateUUID(), entry, current.version, writeToken);

  await updateCirclePicture(circleId, photo);
}
