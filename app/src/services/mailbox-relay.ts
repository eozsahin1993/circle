import { Buffer } from 'buffer';

import { authorizedFetch } from '@/services/relay';

/**
 * Thin fetch-based client for the invite mailbox's endpoints — see
 * server/INVITE_FLOW.md and server/internal/api/invitemailbox. Same
 * division of labor as relay.ts: this module only knows how to talk to
 * the wire, nothing about invite-code derivation or decryption (that's
 * services/crypto.ts and the domain usecases that call this).
 */

export type MailboxJoinRequest = {
  requesterId: string;
  encryptedRequest: Uint8Array;
  encryptedApproval: Uint8Array | null;
  createdAt: number;
};

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

/** Writes a join request row — PUT /v1/invites/{inviteTag}/requests/{requesterId}. Idempotent — a retry converges rather than erroring. */
export async function putJoinRequest(inviteTag: string, requesterId: string, encryptedRequest: Uint8Array): Promise<void> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}/requests/${requesterId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedRequest: Buffer.from(encryptedRequest).toString('base64') }),
  });
  if (!response.ok) {
    throw new Error(`Failed to submit join request: ${response.status}`);
  }
}

/** Lists every pending/approved join request under an invite — GET /v1/invites/{inviteTag}/requests. Creator-side ("discover"). */
export async function listJoinRequests(inviteTag: string): Promise<MailboxJoinRequest[]> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}/requests`);
  if (!response.ok) {
    throw new Error(`Failed to list join requests: ${response.status}`);
  }
  const body = (await response.json()) as {
    requests: { requesterId: string; encryptedRequest: string; encryptedApproval: string | null; createdAt: number }[];
  };
  return body.requests.map((request) => ({
    requesterId: request.requesterId,
    encryptedRequest: new Uint8Array(Buffer.from(request.encryptedRequest, 'base64')),
    encryptedApproval: request.encryptedApproval ? new Uint8Array(Buffer.from(request.encryptedApproval, 'base64')) : null,
    createdAt: request.createdAt,
  }));
}

/**
 * Polls a specific join request's approval field — GET
 * /v1/invites/{inviteTag}/requests/{requesterId}. Requester-side
 * ("complete"). Returns null while still pending; throws if the request
 * row itself is gone (invite expired/evicted before anyone approved it).
 */
export async function getJoinRequestApproval(inviteTag: string, requesterId: string): Promise<Uint8Array | null> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}/requests/${requesterId}`);
  if (!response.ok) {
    throw new Error(`Failed to check join request: ${response.status}`);
  }
  const body = (await response.json()) as { encryptedApproval: string | null };
  return body.encryptedApproval ? new Uint8Array(Buffer.from(body.encryptedApproval, 'base64')) : null;
}

/** Approves a join request — PUT /v1/invites/{inviteTag}/requests/{requesterId}/approval. Creator-side. */
export async function putJoinApproval(inviteTag: string, requesterId: string, encryptedApproval: Uint8Array): Promise<void> {
  const response = await authorizedFetch(`/v1/invites/${inviteTag}/requests/${requesterId}/approval`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encryptedApproval: Buffer.from(encryptedApproval).toString('base64') }),
  });
  if (!response.ok) {
    throw new Error(`Failed to approve join request: ${response.status}`);
  }
}
