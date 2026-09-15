import { File, Paths, UploadType } from 'expo-file-system';
import { bytesToHex } from '@noble/curves/utils.js';

import { generateUUID } from '@/core/crypto/primitives';
import { authorizedFetch, describeError } from '@/core/services/relay';
import { BlobAlreadyExistsError, BlobDeleteRefusedError, RateLimitedError } from '@/core/services/relay-errors';

/**
 * The relay's blob endpoints (server-side: getuploadtarget,
 * getcoverphotouploadtarget, getblob, deleteblob) and the one upload that
 * bypasses it for S3.
 */

export type UploadTarget = {
  url: string;
  fields: Record<string, string>;
};

/**
 * Obtains a presigned upload target for one entry's blob — POST
 * /v1/circles/{syncId}/entries/{entryId}/upload (POST despite not
 * mutating anything server-side: writeToken belongs in the body, not a
 * query param access logs commonly capture by default). Gated by the
 * write token (unlike downloads — obtaining an upload URL is a write
 * capability) and single-use: `BlobAlreadyExistsError` isn't necessarily
 * a failure, it's also what a legitimate retry sees once the earlier
 * upload succeeded.
 */
export async function getUploadTarget(
  syncId: string,
  entryId: string,
  writeToken: Uint8Array,
  uploaderPublicKey: Uint8Array
): Promise<UploadTarget> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/entries/${entryId}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writeToken: bytesToHex(writeToken),
      uploaderPublicKey: bytesToHex(uploaderPublicKey),
    }),
  });
  if (response.status === 409) {
    throw new BlobAlreadyExistsError();
  }
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to get upload target'));
  }
  return response.json();
}

/**
 * Obtains a presigned upload target for a circle's cover photo — POST
 * /v1/circles/{syncId}/cover-photo/upload (same not-mutating-but-POST
 * reasoning as getUploadTarget above). Always the same key (see
 * getUploadTarget's doc comment for the entryID-keyed default; this one
 * doesn't have that) and always overwritable — repeatable on purpose,
 * unlike getUploadTarget's single-use guarantee. Dual-gated: writeToken
 * proves "a current member," authorityPublicKey + signature prove "an
 * admin" (signature must verify against `deriveCoverPhotoUploadMessage(syncId)`
 * — see crypto.ts). No `BlobAlreadyExistsError` case here; that's exactly
 * the failure mode this endpoint doesn't have.
 */
export async function getCoverPhotoUploadTarget(
  syncId: string,
  writeToken: Uint8Array,
  authorityPublicKey: Uint8Array,
  signature: Uint8Array
): Promise<UploadTarget> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/cover-photo/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writeToken: bytesToHex(writeToken),
      authorityPublicKey: bytesToHex(authorityPublicKey),
      signature: bytesToHex(signature),
    }),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to get cover-photo upload target'));
  }
  return response.json();
}

/**
 * Deletes one entry's ciphertext — POST
 * /v1/circles/{syncId}/entries/{entryId}/delete-blob. The only relay call
 * that removes anything, and it removes bytes only: the entries naming
 * this blob stay in the log, immutable, so replay still converges.
 *
 * Gated on a signature over `deriveDeleteBlobMessage(syncId, entryId)`
 * that verifies against the public key the relay recorded at upload time
 * — proof of possessing the uploader's own circle identity key, not just
 * knowledge of its (already-public, see attribution) public half. An
 * admin deleting someone else's photo signs the same message with their
 * authority key instead, passed alongside as `authorityPublicKey` +
 * `signature` — the relay can't check the clients' author-or-admin rule
 * itself, since the author's key is inside the ciphertext.
 *
 * Idempotent: deleting what's already gone succeeds, which is what makes
 * the outbox safe to retry this from.
 */
export async function deleteBlob(
  syncId: string,
  entryId: string,
  writeToken: Uint8Array,
  uploaderSignature?: Uint8Array,
  authority?: { publicKey: Uint8Array; signature: Uint8Array }
): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/entries/${entryId}/delete-blob`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      writeToken: bytesToHex(writeToken),
      ...(uploaderSignature ? { uploaderSignature: bytesToHex(uploaderSignature) } : {}),
      ...(authority
        ? {
            authorityPublicKey: bytesToHex(authority.publicKey),
            signature: bytesToHex(authority.signature),
          }
        : {}),
    }),
  });
  if (response.status === 403) {
    throw new BlobDeleteRefusedError(await describeError(response, 'The relay refused to delete this blob'));
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to delete blob'));
  }
}

/**
 * Downloads one entry's ciphertext bytes — GET
 * /v1/circles/{syncId}/entries/{entryId}/blob, following the relay's
 * redirect to the presigned S3 URL. Returns null if nothing was ever
 * uploaded there — see getUploadTarget's doc comment on GetDownloadURL:
 * that's expected (e.g. a circle with no cover photo set yet), not an
 * error.
 */
export async function getBlob(syncId: string, entryId: string): Promise<Uint8Array | null> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/entries/${entryId}/blob`);
  if (response.status === 404) return null;
  if (response.status === 429) {
    throw new RateLimitedError();
  }
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to download blob'));
  }
  return new Uint8Array(await response.arrayBuffer());
}


/**
 * Uploads ciphertext bytes straight to S3 using the presigned POST target
 * a `getUploadTarget` response handed back — never touches the relay itself.
 */
export async function uploadBlob(target: UploadTarget, bytes: Uint8Array): Promise<void> {
  const file = new File(Paths.cache, `upload-${generateUUID()}`);
  file.create({ overwrite: true });
  file.write(bytes);
  try {
    const result = await file.upload(target.url, {
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      parameters: target.fields,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Failed to upload blob: ${result.status} ${result.body}`);
    }
  } finally {
    file.delete();
  }
}
