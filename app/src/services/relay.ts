import { Buffer } from 'buffer';
import { File, Paths, UploadType } from 'expo-file-system';

import { generateUUID } from '@/services/crypto';
import { getAuthToken } from '@/services/keystore';

/**
 * Thin fetch-based client for the relay's three endpoints — see
 * server/DESIGN.md and server/internal/api. No retry/queueing logic
 * here; that's `domain/usecases/circle/sync-circle.ts`'s job. This module only
 * knows how to talk to the wire, nothing about outbox/circleLog state.
 */

export type UploadTarget = {
  url: string;
  fields: Record<string, string>;
};

export type AppendResult = {
  epoch: number;
  receivedAt: number;
  upload: UploadTarget;
};

export type LogEntry = {
  epoch: number;
  encryptedMeta: Uint8Array;
  receivedAt: number;
};

export type FetchEntriesResult = {
  entries: LogEntry[];
  latestEpoch: number;
  oldestAvailableEpoch: number;
};

function baseUrl(): string {
  const url = process.env.EXPO_PUBLIC_RELAY_URL;
  if (!url) throw new Error('EXPO_PUBLIC_RELAY_URL is not set.');
  return url;
}

/**
 * fetch, with the stored session token attached — every circle-log route
 * requires one now (see server's auth.RequireSession). Sign-in itself
 * doesn't go through this (that's how you get a token in the first
 * place); logout takes its token as a parameter instead, since it revokes
 * a specific token rather than "whatever's currently stored." Exported so
 * other relay-facing modules (e.g. services/mailbox-relay.ts) can reuse
 * the same session-attaching wrapper instead of duplicating it.
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

/** Appends one entry to a circle's log — POST /v1/circles/{circleLogId}/entries. */
export async function appendEntry(circleLogId: string, entryId: string, encryptedMeta: Uint8Array): Promise<AppendResult> {
  const response = await authorizedFetch(`/v1/circles/${circleLogId}/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId, encryptedMeta: Buffer.from(encryptedMeta).toString('base64') }),
  });
  if (!response.ok) {
    throw new Error(`Failed to append entry: ${response.status}`);
  }
  const body = await response.json();
  return { epoch: body.epoch, receivedAt: body.receivedAt, upload: body.upload };
}

/** Fetches every entry after `since` — GET /v1/circles/{circleLogId}/entries?since=. */
export async function fetchEntries(circleLogId: string, since: number): Promise<FetchEntriesResult> {
  const response = await authorizedFetch(`/v1/circles/${circleLogId}/entries?since=${since}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch entries: ${response.status}`);
  }
  const body = await response.json();
  return {
    entries: (body.entries as { epoch: number; encryptedMeta: string; receivedAt: number }[]).map((entry) => ({
      epoch: entry.epoch,
      encryptedMeta: new Uint8Array(Buffer.from(entry.encryptedMeta, 'base64')),
      receivedAt: entry.receivedAt,
    })),
    latestEpoch: body.latestEpoch,
    oldestAvailableEpoch: body.oldestAvailableEpoch,
  };
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
    throw new Error(`Failed to fetch manifest: ${response.status}`);
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
    throw new Error(`Failed to save manifest: ${response.status}`);
  }
}

/**
 * Uploads ciphertext bytes straight to S3 using the presigned POST target
 * an `appendEntry` response handed back — never touches the relay itself.
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
    throw new Error(`${provider} sign-in failed: ${response.status}`);
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
    throw new Error(`Logout failed: ${response.status}`);
  }
}
