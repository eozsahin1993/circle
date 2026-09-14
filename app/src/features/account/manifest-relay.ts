import { Buffer } from 'buffer';

import { authorizedFetch, describeError } from '@/services/relay';

/**
 * Fetches this account's encrypted circle-membership manifest — GET
 * /v1/account/manifest. Returns null before the account has ever stored
 * one (a fresh account, or a device that predates this feature). The
 * relay only ever sees ciphertext; decrypting it is the caller's job (see
 * `deriveManifestKey` in services/crypto.ts).
 */
export async function getManifest(): Promise<StoredManifest> {
  const response = await authorizedFetch('/v1/account/manifest');
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to fetch manifest'));
  }
  const body = (await response.json()) as { blob: string | null; version?: number };
  return {
    blob: body.blob ? new Uint8Array(Buffer.from(body.blob, 'base64')) : null,
    version: body.version ?? 0,
  };
}

export type StoredManifest = {
  /** Null before this account has ever stored one. */
  blob: Uint8Array | null;
  /** Quote back when writing. 0 for never-stored and for pre-versioning rows alike. */
  version: number;
};

/**
 * Raised when the manifest moved between the read and the write — another of
 * this account's devices got there first. The caller has to re-read and
 * reapply rather than retrying the same blob, which would drop whatever that
 * device recorded (see `putAccountManifest`).
 */
export class ManifestConflictError extends Error {
  constructor() {
    super('The manifest changed since it was read.');
    this.name = 'ManifestConflictError';
  }
}

/** Replaces this account's manifest if it's still at `expectedVersion` — PUT /v1/account/manifest. */
export async function putManifest(blob: Uint8Array, expectedVersion: number): Promise<void> {
  const response = await authorizedFetch('/v1/account/manifest', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blob: Buffer.from(blob).toString('base64'), expectedVersion }),
  });
  if (response.status === 409) throw new ManifestConflictError();
  if (!response.ok) {
    throw new Error(await describeError(response, 'Failed to save manifest'));
  }
}
