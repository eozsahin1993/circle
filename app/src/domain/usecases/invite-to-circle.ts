import { bytesToHex } from '@noble/curves/utils.js';

import { generateInviteCode } from '@/services/crypto';
import { getCurrentInvite, getMemberByPublicKey, insertInvite, MemberRoles, revokeInvite, type Invite } from '@/data/db';
import { getCircleIdentity } from '@/services/keystore';

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

async function createInvite(circleId: string, createdByPublicKey: string): Promise<Invite> {
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
