import { Buffer } from 'buffer';
import * as Device from 'expo-device';
import { File, Paths, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';
import { bytesToHex } from '@noble/curves/utils.js';

import { generateUUID } from '@/services/crypto';
import { getAuthToken } from '@/services/keystore';

/**
 * Thin fetch-based client for the relay's circle-log endpoints — see
 * server/SYNC_DESIGN.md and server/internal/api. No retry/queueing logic
 * here; that's `domain/usecases/circle/sync-circle.ts`'s job. This module
 * only knows how to talk to the wire, nothing about outbox/key state.
 * Raw key/token/signature material is always accepted as `Uint8Array` and
 * hex-encoded right here at the wire boundary — callers never hand-encode.
 */

export type Namespace = 'meta' | 'content';

export type UploadTarget = {
  url: string;
  fields: Record<string, string>;
};

export type AppendResult = {
  epoch: number;
  receivedAt: number;
};

export type LogEntry = {
  epoch: number;
  /** Plaintext — which content-key version `encryptedMeta` was encrypted under, for direct lookup instead of trial-decryption. */
  keyVersion: number;
  encryptedMeta: Uint8Array;
  receivedAt: number;
};

export type FetchEntriesResult = {
  entries: LogEntry[];
  currentEpoch: number;
};

/** Thrown by `getUploadTarget` specifically — see its own doc comment for why this isn't necessarily a failure. */
export class BlobAlreadyExistsError extends Error {
  constructor() {
    super('A blob already exists for this entry.');
    this.name = 'BlobAlreadyExistsError';
  }
}

function baseUrl(): string {
  const url = process.env.EXPO_PUBLIC_RELAY_URL;
  if (!url) throw new Error('EXPO_PUBLIC_RELAY_URL is not set.');
  // The Android emulator can't reach the host machine via `localhost` — that
  // resolves to the emulator itself, not the Mac running the relay. 10.0.2.2
  // is the emulator's alias for the host's loopback interface.
  //
  // Gated on `!Device.isDevice` because that alias means nothing on a real
  // phone: 10.0.2.2 is simply unroutable on a LAN, so the rewrite turns
  // every relay call into a TCP connect that hangs for ~20s before the
  // kernel gives up, rather than failing fast. A physical device needs the
  // host's real LAN IP in EXPO_PUBLIC_RELAY_URL, so leave the URL alone and
  // let a wrong one fail immediately and visibly.
  if (Platform.OS === 'android' && !Device.isDevice) {
    return url.replace('//localhost', '//10.0.2.2').replace('//127.0.0.1', '//10.0.2.2');
  }
  return url;
}

/**
 * Reads a failed response's body so callers see the relay's actual reason,
 * not just a bare status code — httputil.WriteError's shape is
 * `{"error": "..."}`, so that string is pulled out and appended when
 * present; otherwise falls back to whatever raw text came back.
 */
async function describeError(response: Response, summary: string): Promise<string> {
  const text = await response.text().catch(() => '');
  let detail = text;
  try {
    const body = JSON.parse(text);
    if (typeof body?.error === 'string' && body.error) detail = body.error;
  } catch {
    // not JSON — use the raw text as-is
  }
  return detail ? `${summary}: ${response.status} ${detail}` : `${summary}: ${response.status}`;
}

/**
 * fetch with the stored session token attached — every circle-log route
 * requires one (server's auth.RequireSession). Exported so other
 * relay-facing modules (e.g. services/mailbox-relay.ts) can reuse it.
 */
export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  if (!token) {
    throw new Error('Not signed in.');
  }
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
}

/**
 * Creates a circle's control state — POST /v1/circles/{syncId} (see
 * server/SYNC_DESIGN.md operation 1). Nothing else is written here: the
 * founder's own member_added entry is a separate, subsequent
 * `appendEntry` call using the token this registers.
 */
export async function bootstrapCircle(syncId: string, founderAuthorityPublicKey: Uint8Array, initialWriteTokenHash: string): Promise<void> {
  const response = await authorizedFetch(`/v1/circles/${syncId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      founderAuthorityPublicKey: bytesToHex(founderAuthorityPublicKey),
      initialWriteTokenHash,
    }),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to create circle'));
  }
}

/**
 * Appends one entry to a circle's log — POST /v1/circles/{syncId}/entries.
 * `keyVersion` is sent as plaintext alongside the ciphertext (not part of
 * it) — which content key `encryptedMeta` was actually encrypted under,
 * so a reader can pick the right key by direct lookup rather than
 * trial-decrypting with every version it holds.
 */
export async function appendEntry(
  syncId: string,
  namespace: Namespace,
  entryId: string,
  encryptedMeta: Uint8Array,
  keyVersion: number,
  writeToken: Uint8Array
): Promise<AppendResult> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      namespace,
      entryId,
      encryptedMeta: Buffer.from(encryptedMeta).toString('base64'),
      keyVersion,
      writeToken: bytesToHex(writeToken),
    }),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to append entry'));
  }
  const body = await response.json();
  return { epoch: body.epoch, receivedAt: body.receivedAt };
}

/**
 * Rotates a circle's write token — POST /v1/circles/{syncId}/rotate. See
 * server/SYNC_DESIGN.md's "Remove a member" operation: appends the
 * key_rotation meta entry and swaps in the new write token atomically.
 * `signature` must verify against `deriveRotateMessage(syncId, entryId,
 * newWriteTokenHash)` — see crypto.ts.
 */
export async function rotateLog(
  syncId: string,
  entryId: string,
  encryptedMeta: Uint8Array,
  currentKeyVersion: number,
  currentWriteToken: Uint8Array,
  newWriteTokenHash: string,
  authorityPublicKey: Uint8Array,
  signature: Uint8Array
): Promise<AppendResult> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/rotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entryId,
      encryptedMeta: Buffer.from(encryptedMeta).toString('base64'),
      currentKeyVersion,
      currentWriteToken: bytesToHex(currentWriteToken),
      newWriteTokenHash,
      authorityPublicKey: bytesToHex(authorityPublicKey),
      signature: bytesToHex(signature),
    }),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to rotate'));
  }
  const body = await response.json();
  return { epoch: body.epoch, receivedAt: body.receivedAt };
}

/** Fetches every entry in `namespace` after `since` — GET /v1/circles/{syncId}/entries?namespace=&since=. */
export async function fetchEntries(syncId: string, namespace: Namespace, since: number): Promise<FetchEntriesResult> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/entries?namespace=${namespace}&since=${since}`);
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to fetch entries'));
  }
  const body = await response.json();
  return {
    entries: (body.entries as { epoch: number; keyVersion: number; encryptedMeta: string; receivedAt: number }[]).map((entry) => ({
      epoch: entry.epoch,
      keyVersion: entry.keyVersion,
      encryptedMeta: new Uint8Array(Buffer.from(entry.encryptedMeta, 'base64')),
      receivedAt: entry.receivedAt,
    })),
    currentEpoch: body.currentEpoch,
  };
}

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
export async function getUploadTarget(syncId: string, entryId: string, writeToken: Uint8Array): Promise<UploadTarget> {
  const response = await authorizedFetch(`/v1/circles/${syncId}/entries/${entryId}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ writeToken: bytesToHex(writeToken) }),
  });
  if (response.status === 409) {
    throw new BlobAlreadyExistsError();
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
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to download blob'));
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetches this account's encrypted circle-membership manifest — GET
 * /v1/account/manifest. Returns null before the account has ever stored
 * one (a fresh account, or a device that predates this feature). The
 * relay only ever sees ciphertext; decrypting it is the caller's job (see
 * `deriveManifestKey` in services/crypto.ts).
 */
export async function getManifest(): Promise<Uint8Array | null> {
  const response = await authorizedFetch('/v1/account/manifest');
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to fetch manifest'));
  }
  const body = (await response.json()) as { blob: string | null };
  return body.blob ? new Uint8Array(Buffer.from(body.blob, 'base64')) : null;
}

/** Overwrites this account's encrypted circle-membership manifest — PUT /v1/account/manifest. */
export async function putManifest(blob: Uint8Array): Promise<void> {
  const response = await authorizedFetch('/v1/account/manifest', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blob: Buffer.from(blob).toString('base64') }),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to save manifest'));
  }
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

/**
 * Exchanges a provider ID token for a relay bearer session token — POST
 * /v1/auth/google or /v1/auth/apple. See server/internal/api/authgoogle
 * and authapple: the relay verifies idToken against the provider's own
 * signing keys itself, this call doesn't trust anything client-side about
 * the token's contents.
 */
async function signIn(provider: 'google' | 'apple', idToken: string): Promise<string> {
  const response = await fetch(`${baseUrl()}/v1/auth/${provider}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) {
    throw new Error(await describeError(response, `${provider} sign-in failed`));
  }
  const body = await response.json();
  return body.token;
}

export const signInWithGoogle = (idToken: string) => signIn('google', idToken);
export const signInWithApple = (idToken: string) => signIn('apple', idToken);

/** Revokes a bearer session token — POST /v1/auth/logout. Idempotent, same as the endpoint itself. */
export async function logout(token: string): Promise<void> {
  const response = await fetch(`${baseUrl()}/v1/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(await describeError(response, 'Logout failed'));
  }
}
