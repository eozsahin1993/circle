import { Buffer } from 'buffer';

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import {
  decrypt,
  deriveInvitePreviewKey,
  deriveInviteTag,
  deriveJoinRequestKey,
  encryptJSON,
  generateInviteCode,
  generateUUID,
  sealToPublicKey,
  sign,
} from '@/services/crypto';
import {
  getCircle,
  getCurrentInvite,
  getMemberByPublicKey,
  getProfile,
  insertInvite,
  insertMemberIfAbsent,
  insertOutboxEntry,
  MemberRoles,
  OutboxStatuses,
  revokeInvite,
  type Invite,
} from '@/data/db';
import type { InvitePreviewPayload, JoinApprovalEnvelope, JoinApprovalPayload, JoinRequestPayload } from '@/domain/usecases/circle/invite-payloads';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { bytesToDataUri } from '@/services/image';
import { pullMeta } from '@/sync/pull-log';
import { getCircleIdentity, getCircleKeyMap } from '@/services/keystore';
import { deleteJoinRequest, listJoinRequests, putInvitePreview, putJoinApproval } from '@/services/mailbox-relay';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolves this device's own public key + roster row for a circle, or null before it has an identity there. */
async function getOwnMember(circleId: string) {
  const identity = await getCircleIdentity(circleId);
  if (!identity) return null;

  const publicKey = bytesToHex(identity.publicKey);
  const member = await getMemberByPublicKey(circleId, publicKey);
  return member ? { publicKey, member } : null;
}

/** Whether this device is an admin of the circle — for screens to decide what to show, not just what to allow. */
export async function isCircleAdmin(circleId: string): Promise<boolean> {
  const own = await getOwnMember(circleId);
  return own?.member.role === MemberRoles.admin;
}

/** Resolves this device's own public key in the circle, and confirms it's an admin. */
async function requireAdminPublicKey(circleId: string): Promise<string> {
  const own = await getOwnMember(circleId);
  if (own?.member.role !== MemberRoles.admin) throw new Error("Only an admin can manage this circle's invite.");

  return own.publicKey;
}

/**
 * Writes the server-side `sk = "invite"` row (see server/INVITE_FLOW.md) —
 * the circle's current name, encrypted under a key derived from the
 * invite code alone, so anyone who taps the link can preview what they're
 * about to join before requesting to. Not best-effort: an invite whose
 * preview never lands is unjoinable, so a failure here should surface the
 * same way any other invite-creation failure does.
 */
async function writeInvitePreview(code: string, circleName: string, createdByPublicKey: string): Promise<void> {
  const profile = await getProfile();
  const payload: InvitePreviewPayload = { name: circleName, createdByName: profile?.name ?? '', createdByPublicKey };
  const key = deriveInvitePreviewKey(code);
  await putInvitePreview(deriveInviteTag(code), encryptJSON(payload, key));
}

async function createInvite(circleId: string, createdByPublicKey: string): Promise<Invite> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('Circle not found.');

  const now = Date.now();
  const invite: Invite = {
    code: generateInviteCode(),
    circleId,
    createdByPublicKey,
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
    revokedAt: null,
  };
  await insertInvite(invite);
  await writeInvitePreview(invite.code, circle.name, createdByPublicKey);
  return invite;
}

/**
 * Returns the circle's current, live invite — creating one if there isn't
 * one yet, or the existing one has expired. Reused rather than minted
 * fresh on every visit to the invite screen, so the code someone already
 * shared keeps working.
 */
export async function getOrCreateInvite(circleId: string): Promise<Invite> {
  const publicKey = await requireAdminPublicKey(circleId);

  const current = await getCurrentInvite(circleId);
  if (current && current.expiresAt > Date.now()) return current;

  return createInvite(circleId, publicKey);
}

/**
 * Revokes the circle's current invite (if any) and issues a fresh one —
 * kills the old link/code for anyone still holding it, without touching
 * members who already joined through it.
 */
export async function replaceInvite(circleId: string): Promise<Invite> {
  const publicKey = await requireAdminPublicKey(circleId);

  const current = await getCurrentInvite(circleId);
  if (current) await revokeInvite(current.code);

  return createInvite(circleId, publicKey);
}

/**
 * Confirms this device is specifically the invite's *creator*, not just
 * any admin (server/DESIGN.md's "Invites": an admin who didn't create
 * this invite has no more context to judge a request than a stranger
 * would). Client-side only — the relay is blind and can't enforce it.
 */
async function requireInviteCreatorPublicKey(circleId: string): Promise<{ publicKey: string; invite: Invite }> {
  const own = await getOwnMember(circleId);
  const invite = await getCurrentInvite(circleId);
  if (!own || !invite || own.publicKey !== invite.createdByPublicKey) {
    throw new Error("Only this invite's creator can see or approve its join requests.");
  }
  return { publicKey: own.publicKey, invite };
}

export type PendingRequest = {
  requesterId: string;
  selfReportedName: string;
  /** Data URI of the requester's self-reported thumbnail, if they sent one — see `compressToThumbnail`. */
  pictureUri?: string;
  createdAt: number;
};

/**
 * Lists join requests still awaiting this device's decision — self-
 * reported name and picture only, not verified identity (server/DESIGN.md).
 * Skips rows that fail to decrypt (e.g. stale, from a previous invite)
 * rather than failing the whole list, and rows already carrying an
 * `encryptedApproval` (approved in place, not deleted, so they'd
 * otherwise keep reappearing here with nothing left to do).
 */
export async function discoverPendingRequests(circleId: string): Promise<PendingRequest[]> {
  const { invite } = await requireInviteCreatorPublicKey(circleId);
  const key = deriveJoinRequestKey(invite.code);

  const requests = await listJoinRequests(deriveInviteTag(invite.code));
  const pending: PendingRequest[] = [];
  for (const request of requests) {
    if (request.encryptedApproval) continue;
    try {
      const payload = JSON.parse(new TextDecoder().decode(decrypt(request.encryptedRequest, key))) as JoinRequestPayload;
      pending.push({
        requesterId: request.requesterId,
        selfReportedName: payload.selfReportedName,
        pictureUri: payload.pictureThumbnail ? bytesToDataUri(Buffer.from(payload.pictureThumbnail, 'base64')) : undefined,
        createdAt: request.createdAt,
      });
    } catch (err) {
      console.error('Failed to decrypt a join request', err);
    }
  }
  return pending;
}

/**
 * Dismisses a pending join request without approving it ("not now") —
 * permanently: the request row is deleted server-side, so the requester
 * would need to submit a fresh request (reopen the invite link) to try
 * again. Same creator-only gate as `approveJoinRequest`.
 */
export async function denyJoinRequest(circleId: string, requesterId: string): Promise<void> {
  const { invite } = await requireInviteCreatorPublicKey(circleId);
  await deleteJoinRequest(deriveInviteTag(invite.code), requesterId);
}

/**
 * Approves one pending join request: seals this device's entire
 * version→content-key map (not just the current version — a joiner needs
 * every version to decrypt history predating their join) + circle name
 * to the requester's ephemeral public key.
 *
 * Also signs the approval with this device's circle identity before
 * sealing — without it, any existing member (not just the creator) could
 * forge an equally valid-looking approval, since the creator-only check
 * above is client-side only. The signature is what
 * `checkPendingJoinRequest` actually verifies against.
 */
export async function approveJoinRequest(circleId: string, requesterId: string): Promise<void> {
  const { invite } = await requireInviteCreatorPublicKey(circleId);
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('Circle not found.');

  const inviteTag = deriveInviteTag(invite.code);
  const requests = await listJoinRequests(inviteTag);
  const request = requests.find((r) => r.requesterId === requesterId);
  if (!request) throw new Error('That join request is no longer available.');

  const requestKey = deriveJoinRequestKey(invite.code);
  const { ephemeralPublicKey, identityPublicKey, encPublicKey, selfReportedName, pictureThumbnail } = JSON.parse(
    new TextDecoder().decode(decrypt(request.encryptedRequest, requestKey))
  ) as JoinRequestPayload;

  // Catch up on meta before sealing (server/SYNC_DESIGN.md "Add a member"):
  // a stale approver would otherwise hand over an incomplete key map, and
  // the joiner would be unable to read history it should have.
  await pullMeta(circleId);

  const keyMap = await getCircleKeyMap(circleId);
  if (!keyMap) throw new Error('No content key on this device.');
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');

  const hexKeyMap = Object.fromEntries(Object.entries(keyMap).map(([version, key]) => [version, bytesToHex(key)]));
  const approval: JoinApprovalPayload = { keyMap: hexKeyMap, syncId: circle.syncId, circleName: circle.name };
  const signature = sign(new TextEncoder().encode(JSON.stringify(approval)), identity.secretKey);
  const envelope: JoinApprovalEnvelope = { approval, signature: bytesToHex(signature) };

  const sealed = sealToPublicKey(new TextEncoder().encode(JSON.stringify(envelope)), hexToBytes(ephemeralPublicKey));
  await putJoinApproval(inviteTag, requesterId, sealed);

  // Only an admin may write `member_added` (server/SYNC_DESIGN.md's
  // predicate table), so it is written here, by the approver, rather than
  // self-announced by the joiner — an entry signed by someone no device
  // has yet heard of is discarded by every honest client. This is what
  // makes the new member visible to everyone else: the joiner supplied
  // the public halves, and this signature is the circle vouching for them.
  const currentVersion = Math.max(...Object.keys(keyMap).map(Number));
  const memberAddedEntry = buildAndEncryptLogEntry(
    EntryTypes.MEMBER_ADDED,
    {
      identityPublicKey,
      encPublicKey,
      name: selfReportedName,
      role: MemberRoles.member,
      keyVersion: currentVersion,
      picture: pictureThumbnail,
    },
    identity,
    keyMap[currentVersion]
  );
  await insertOutboxEntry({
    circleId,
    entryType: EntryTypes.MEMBER_ADDED,
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    encryptedMeta: memberAddedEntry,
  });

  // Applied locally too, so the approver's own roster updates immediately
  // instead of only when its next pass walks this entry back. Idempotent
  // against that later echo.
  await insertMemberIfAbsent({
    circleId,
    identityPublicKey,
    encPublicKey,
    memberId: generateUUID(),
    role: MemberRoles.member,
    name: selfReportedName,
    picture: pictureThumbnail ? Buffer.from(pictureThumbnail, 'base64') : null,
    joinedAt: Date.now(),
  });

  drainOutbox(circleId).catch((err) => console.error('Failed to push member_added', err));
}
