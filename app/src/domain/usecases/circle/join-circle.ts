import { Buffer } from 'buffer';

import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import {
  decrypt,
  deriveCircleIdentity,
  deriveCircleSealingKeypair,
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
  insertPendingJoinRequest,
  MemberRoles,
  type PendingJoinRequest,
} from '@/data/db';
import type { InvitePreviewPayload, JoinApprovalEnvelope, JoinRequestPayload } from '@/domain/usecases/circle/invite-payloads';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { syncAccountManifestBestEffort } from '@/domain/usecases/account/account-manifest';
import { compressToThumbnail } from '@/services/image';
import { deletePendingJoinKeypair, getMasterSeed, getPendingJoinKeypair, saveCircleIdentity, saveCircleKeyMap, savePendingJoinKeypair } from '@/services/keystore';
import { getInvitePreview, getJoinRequestApproval, putJoinRequest } from '@/services/mailbox-relay';
import { getBlob } from '@/services/relay';

/**
 * Fetches and decrypts the circle's cover photo, if it has one — the
 * fixed, predictable `entryId: 'cover'` location (see
 * services/relay.ts's `getBlob` and set-cover-photo.ts) means a joiner
 * can fetch it directly on join without needing `pullCircle`/meta-log
 * consumption to exist first (which nothing in the app does yet — see
 * this function's caller's doc comment). Best-effort: a stranger's
 * tampered or missing object just decrypts to nothing usable, caught
 * here rather than failing the join over a picture.
 */
async function fetchCoverPhoto(syncId: string, contentKey: Uint8Array): Promise<Uint8Array | null> {
  try {
    const encrypted = await getBlob(syncId, 'cover');
    return encrypted ? decrypt(encrypted, contentKey) : null;
  } catch (err) {
    console.error('Failed to fetch cover photo while joining', err);
    return null;
  }
}

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

  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed yet — onboarding must generate one before joining any circle.');

  const requestId = generateUUID();
  const keypair = generateEphemeralKeypair();
  const profile = await getProfile();

  // The circle identity is derived here rather than at completion because
  // its *public* halves have to travel in this request: only an admin may
  // write `member_added` (server/SYNC_DESIGN.md's predicate table), so the
  // approver names this member, and can't do that without their keys.
  // Nothing shared is needed to derive them — circleId is a local id this
  // device invents, and the secret in the derivation is the seed. It's
  // parked on the pending row because the same id must be reused at
  // completion, or the identity would be orphaned.
  const circleId = generateUUID();
  const identity = deriveCircleIdentity(masterSeed, circleId);
  const sealingKeypair = deriveCircleSealingKeypair(masterSeed, circleId);

  // Best-effort — a thumbnail failure shouldn't block submitting the
  // request itself; the approval screen just falls back to a placeholder.
  let pictureThumbnail: string | undefined;
  if (profile?.picture) {
    try {
      pictureThumbnail = Buffer.from(await compressToThumbnail(profile.picture)).toString('base64');
    } catch (err) {
      console.error('Failed to compress profile picture for join request', err);
    }
  }

  const request: JoinRequestPayload = {
    ephemeralPublicKey: bytesToHex(keypair.publicKey),
    identityPublicKey: bytesToHex(identity.publicKey),
    encPublicKey: bytesToHex(sealingKeypair.publicKey),
    selfReportedName: profile?.name ?? '',
    pictureThumbnail,
  };
  const key = deriveJoinRequestKey(inviteCode);
  await putJoinRequest(deriveInviteTag(inviteCode), requestId, encryptJSON(request, key));

  await savePendingJoinKeypair(requestId, keypair);
  await insertPendingJoinRequest({
    id: requestId,
    circleId,
    inviteCode,
    circleName: preview.name,
    createdByName: preview.createdByName,
    createdByPublicKey: preview.createdByPublicKey,
    ephemeralPublicKey: bytesToHex(keypair.publicKey),
    submittedAt: Date.now(),
    status: 'pending',
  });

  return { requestId };
}

/**
 * Finishes a join once the approval's been decrypted: mirrors
 * `createCircle`'s order of operations (key map + identity to Keychain
 * before any local DB writes), roster role `member` not `admin`.
 *
 * `keyMap` is the approver's *entire* version→key map, not just the
 * current version — lets this device decrypt history predating its own
 * join (see server/SYNC_DESIGN.md's "Add a member"). Its own
 * `member_added` entry uses the current (highest) version, same as any
 * post would.
 *
 * Adopts the `circleId` minted back at `requestToJoin` rather than
 * generating a fresh one — the identity whose public halves the approver
 * already wrote into `member_added` was derived from that id, so a new
 * one here would silently orphan it.
 *
 * This device does *not* announce itself: `member_added` may only be
 * written by an admin (server/SYNC_DESIGN.md's predicate table), so the
 * approver wrote it, and this device meets its own entry when it walks
 * meta from epoch 0 — where it lands as a no-op against the row inserted
 * here. The local insert exists only so the joiner sees themselves
 * immediately, without waiting for a sync pass.
 */
async function completeJoin(pending: PendingJoinRequest, keyMap: Record<number, Uint8Array>, syncId: string, circleName: string): Promise<{ circleId: string }> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed yet — onboarding must generate one before joining any circle.');

  const currentVersion = Math.max(...Object.keys(keyMap).map(Number));
  const currentKey = keyMap[currentVersion];

  const now = Date.now();
  const { circleId } = pending;
  const memberId = generateUUID();
  const identity = deriveCircleIdentity(masterSeed, circleId);
  const sealingKeypair = deriveCircleSealingKeypair(masterSeed, circleId);

  await saveCircleKeyMap(circleId, keyMap);
  await saveCircleIdentity(circleId, { ...identity, memberId });

  const picture = await fetchCoverPhoto(syncId, currentKey);
  await insertCircle({
    id: circleId,
    name: circleName,
    picture,
    syncId,
    createdAt: now,
    leftAt: null,
    metaCursor: 0,
    contentCursor: 0,
  });

  const profile = await getProfile();
  const identityPublicKey = bytesToHex(identity.publicKey);
  const encPublicKey = bytesToHex(sealingKeypair.publicKey);
  await insertMember({
    circleId,
    identityPublicKey,
    encPublicKey,
    memberId,
    role: MemberRoles.member,
    name: profile?.name ?? '',
    picture: profile?.picture ?? null,
    joinedAt: now,
  });

  await syncAccountManifestBestEffort();

  await deletePendingJoinKeypair(pending.id);
  await deletePendingJoinRequest(pending.id);

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));

  return { circleId };
}

export type PendingJoinCheck = { joined: true; circleId: string } | { joined: false };

/**
 * Checks whether a pending join request has been approved yet — polled,
 * never push-dependent (see server/INVITE_FLOW.md). Returns `{joined:
 * false}` while pending, or once the join has completed, the new
 * circle's id.
 *
 * A signature failure is treated the same as no approval yet, not a
 * fatal error — it's the actual gate deciding this came from the
 * invite's real creator (anyone with the invite code could otherwise
 * forge one) — and the pending row is left in place so a later,
 * legitimate approval can still land.
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

  const keyMap = Object.fromEntries(Object.entries(envelope.approval.keyMap).map(([version, hex]) => [Number(version), hexToBytes(hex)]));
  const { circleId } = await completeJoin(pending, keyMap, envelope.approval.syncId, envelope.approval.circleName);
  return { joined: true, circleId };
}
