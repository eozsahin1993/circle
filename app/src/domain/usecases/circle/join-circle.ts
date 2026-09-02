import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import {
  decrypt,
  deriveCircleIdentity,
  deriveInvitePreviewKey,
  deriveInviteTag,
  deriveJoinRequestKey,
  encryptJSON,
  generateEphemeralKeypair,
  generateUUID,
  openSealedBox,
  verify,
} from '@/services/crypto';
import {
  deletePendingJoinRequest,
  getPendingJoinRequest,
  getProfile,
  insertCircle,
  insertMember,
  insertOutboxEntry,
  insertPendingJoinRequest,
  MemberRoles,
  OutboxStatuses,
  type PendingJoinRequest,
} from '@/data/db';
import type { InvitePreviewPayload, JoinApprovalEnvelope, JoinRequestPayload } from '@/domain/usecases/circle/invite-payloads';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { syncAccountManifestBestEffort } from '@/domain/usecases/account/account-manifest';
import { deletePendingJoinKeypair, getMasterSeed, getPendingJoinKeypair, saveCircleIdentity, saveCircleSecret, savePendingJoinKeypair } from '@/services/keystore';
import { getInvitePreview, getJoinRequestApproval, putJoinRequest } from '@/services/mailbox-relay';

/**
 * Fetches and decrypts an invite's preview — "You're about to join: X" —
 * without submitting a request. Throws if the invite doesn't exist (bad
 * code, or the invite's expired and been evicted server-side).
 */
export async function previewInvite(inviteCode: string): Promise<InvitePreviewPayload> {
  const blob = await getInvitePreview(deriveInviteTag(inviteCode));
  if (!blob) throw new Error('This invite is invalid or has expired.');

  const key = deriveInvitePreviewKey(inviteCode);
  return JSON.parse(new TextDecoder().decode(decrypt(blob, key))) as InvitePreviewPayload;
}

/**
 * Submits a join request against an invite code: generates a one-time
 * keypair for this handshake (see `openSealedBox`'s doc comment),
 * publishes the request to the mailbox, and records it locally so a
 * "pending for Family Circle" screen survives the app being closed and
 * reopened before approval ever lands (see server/INVITE_FLOW.md, step 4).
 */
export async function requestToJoin(inviteCode: string): Promise<{ requestId: string }> {
  const preview = await previewInvite(inviteCode);

  const requestId = generateUUID();
  const keypair = generateEphemeralKeypair();
  const profile = await getProfile();

  const request: JoinRequestPayload = { ephemeralPub: bytesToHex(keypair.publicKey), selfReportedName: profile?.name ?? '' };
  const key = deriveJoinRequestKey(inviteCode);
  await putJoinRequest(deriveInviteTag(inviteCode), requestId, encryptJSON(request, key));

  await savePendingJoinKeypair(requestId, keypair);
  await insertPendingJoinRequest({
    id: requestId,
    inviteCode,
    circleName: preview.name,
    createdByPublicKey: preview.createdByPublicKey,
    ephemeralPublicKey: bytesToHex(keypair.publicKey),
    submittedAt: Date.now(),
    status: 'pending',
  });

  return { requestId };
}

/**
 * Finishes a join once the secret's been decrypted: mirrors
 * `createCircle`'s order of operations exactly (secret + identity to
 * Keychain before any local DB writes), except the roster role is
 * `member`, never `admin` — only the founder auto-admins. Also enqueues a
 * `member_added` outbox entry so existing members eventually learn about
 * this join (once `pullCircle` exists to let them see it — see
 * server/INVITE_FLOW.md's "what this flow depends on" section for why
 * that's a known, separate gap, not a bug here).
 */
async function completeJoin(pending: PendingJoinRequest, secret: Uint8Array, circleName: string): Promise<{ circleId: string }> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed yet — onboarding must generate one before joining any circle.');

  const now = Date.now();
  const circleId = generateUUID();
  const memberId = generateUUID();
  const identity = deriveCircleIdentity(masterSeed, circleId);

  await saveCircleSecret(circleId, secret);
  await saveCircleIdentity(circleId, { ...identity, memberId });

  await insertCircle({ id: circleId, name: circleName, picture: null, createdAt: now, leftAt: null });

  const profile = await getProfile();
  const publicKey = bytesToHex(identity.publicKey);
  await insertMember({
    circleId,
    publicKey,
    memberId,
    role: MemberRoles.member,
    name: profile?.name ?? '',
    picture: profile?.picture ?? null,
    joinedAt: now,
  });

  const encryptedMeta = encryptJSON({ entryType: 'member_added', memberId, publicKey, name: profile?.name ?? '', joinedAt: now }, secret);
  await insertOutboxEntry({
    circleId,
    entryType: 'member_added',
    localId: memberId,
    status: OutboxStatuses.pending,
    epoch: null,
    encryptedMeta,
  });

  await syncAccountManifestBestEffort();

  await deletePendingJoinKeypair(pending.id);
  await deletePendingJoinRequest(pending.id);

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));

  return { circleId };
}

export type PendingJoinCheck = { joined: true; circleId: string } | { joined: false };

/**
 * Checks whether a pending join request has been approved yet — same
 * app-lifecycle-triggered polling as everywhere else in this flow, never
 * push-dependent (see server/INVITE_FLOW.md's goals). Returns `{joined:
 * false}` while still pending, or if the local pending row is already
 * gone (completed elsewhere, or abandoned). Returns the new circle's id
 * once the join has fully completed locally, so the caller can navigate
 * straight to it.
 *
 * An approval that opens but fails signature verification (see
 * `approveJoinRequest`'s doc comment) is treated exactly like no approval
 * having arrived yet, not a fatal error — anyone who knew the invite code
 * and the real circle secret could otherwise get this far, so the
 * signature check is what actually decides whether this approval came
 * from the invite's real creator. The local pending row is left in place
 * either way, so a later, legitimate approval can still land and succeed.
 */
export async function checkPendingJoinRequest(requestId: string): Promise<PendingJoinCheck> {
  const pending = await getPendingJoinRequest(requestId);
  if (!pending) return { joined: false };

  const approval = await getJoinRequestApproval(deriveInviteTag(pending.inviteCode), requestId);
  if (!approval) return { joined: false };

  const keypair = await getPendingJoinKeypair(requestId);
  if (!keypair) return { joined: false };

  const envelope = JSON.parse(new TextDecoder().decode(openSealedBox(approval, keypair))) as JoinApprovalEnvelope;
  const approvalBytes = new TextEncoder().encode(JSON.stringify(envelope.approval));
  const signedByCreator = verify(hexToBytes(envelope.signature), approvalBytes, hexToBytes(pending.createdByPublicKey));
  if (!signedByCreator) {
    console.error('A join approval failed signature verification — ignoring it as untrusted.');
    return { joined: false };
  }

  const { circleId } = await completeJoin(pending, hexToBytes(envelope.approval.secret), envelope.approval.circleName);
  return { joined: true, circleId };
}
