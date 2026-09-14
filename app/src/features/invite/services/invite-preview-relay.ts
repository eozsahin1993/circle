import { Buffer } from 'buffer';

import { authorizedFetch } from '@/core/services/relay';

/** Writes an invite's preview row — PUT /v1/invites/{inviteTag}. */
export async function putInvitePreview(inviteTag: string, encryptedPreview: Uint8Array): Promise<void> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedPreview: Buffer.from(encryptedPreview).toString('base64') }),
  });
  if (!response.ok) {
    throw new Error(`Failed to write invite preview: ${response.status}`);
  }
}

/** Fetches an invite's preview row — GET /v1/invites/{inviteTag}. Returns null if the invite doesn't exist (or has expired). */
export async function getInvitePreview(inviteTag: string): Promise<Uint8Array | null> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch invite preview: ${response.status}`);
  }
  const body = (await response.json()) as { encryptedPreview: string };
  return new Uint8Array(Buffer.from(body.encryptedPreview, 'base64'));
}
