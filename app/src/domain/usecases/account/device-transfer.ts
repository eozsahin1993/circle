import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { getAllCircles, getCircle, getProfile, insertCircle, saveProfile } from '@/data/db';
import {
  decrypt,
  deriveCircleIdentity,
  deriveDeviceTransferRequestKey,
  deriveDeviceTransferTag,
  encryptJSON,
  generateEphemeralKeypair,
  generateInviteCode,
  openSealedBox,
  sealToPublicKey,
} from '@/services/crypto';
import {
  deleteJoinRequest,
  getJoinRequestApproval,
  listJoinRequests,
  putJoinApproval,
  putJoinRequest,
} from '@/services/mailbox-relay';
import {
  getCircleKeyMap,
  getCircleIdentity,
  getMasterSeed,
  saveCircleIdentity,
  saveCircleKeyMap,
  saveMasterSeed,
} from '@/services/keystore';
import type { Keypair } from '@/services/crypto';

/**
 * Moving an account onto a second phone: the invite handshake with the
 * parties swapped, so the device that has nothing publishes a one-time
 * public key and the device that has everything seals the seed to it.
 *
 * Runs on the invite mailbox routes unchanged. That's the shape
 * server/DESIGN.md's section 3 intended — a generic tag-addressed
 * mailbox, of which invites are the first use and this is the second.
 */

/**
 * The whole of what the QR carries.
 *
 * `ephemeralPublicKey` travels here rather than through the mailbox
 * because a relay that supplied it could substitute its own and be sealed
 * the master seed. That constraint is also why the empty device shows the
 * code and the full one scans it, not the reverse.
 */
export type DeviceTransferQrPayload = {
  transferCode: string;
  /** Hex X25519. */
  ephemeralPublicKey: string;
};

/**
 * The waiting device's row. Mostly it just has to exist — the relay
 * refuses an approval without one — but the name gives the confirm prompt
 * something to call the device. Self-reported, never verified.
 */
export type DeviceTransferRequestPayload = {
  deviceName: string;
};

export type TransferredCircle = {
  circleId: string;
  syncId: string;
  name: string;
  /** Local-only, but under a unique index, so both devices agree on one rather than inventing two. */
  memberId: string;
  /**
   * Every version, not just the current one. Content keys are random
   * rather than derived, so unlike identities they can't be recomputed,
   * and reading them back out of the log needs `pullCircle` — still
   * unbuilt (server/INVITE_FLOW.md).
   */
  keyMap: Record<number, string>;
};

/** Sealed to the QR's key, readable by nothing else. */
export type DeviceTransferPayload = {
  /** Hex. Every circle identity derives from this. */
  masterSeed: string;
  profile: {
    name: string;
    /** Base64. Carried so the arriving device doesn't re-ask for what its circles already know. */
    picture?: string;
  };
  circles: TransferredCircle[];
};

/** The waiting device's half of an in-flight transfer. Memory only. */
export type PendingDeviceTransfer = {
  qr: DeviceTransferQrPayload;
  transferCode: string;
  ephemeralKeypair: Keypair;
};

/**
 * Waiting-device side, step one.
 *
 * The keypair isn't persisted, unlike the invite flow's
 * `savePendingJoinKeypair` — a join request is polled for days, a
 * transfer is done or abandoned in one sitting, and a secret that opens a
 * master seed shouldn't outlive the screen holding it. Backgrounding
 * mid-transfer therefore means starting over.
 */
export async function startDeviceTransfer(deviceName: string): Promise<PendingDeviceTransfer> {
  const transferCode = generateInviteCode();
  const ephemeralKeypair = generateEphemeralKeypair();

  const request: DeviceTransferRequestPayload = { deviceName };
  await putJoinRequest(
    deriveDeviceTransferTag(transferCode),
    requesterId(transferCode),
    encryptJSON(request, deriveDeviceTransferRequestKey(transferCode)),
  );

  return {
    qr: { transferCode, ephemeralPublicKey: bytesToHex(ephemeralKeypair.publicKey) },
    transferCode,
    ephemeralKeypair,
  };
}

/**
 * The tag already carries the entropy, so this only needs to be stable
 * across both devices — deriving it avoids a second identifier that would
 * have to travel in the QR.
 */
function requesterId(transferCode: string): string {
  return deriveDeviceTransferTag(transferCode).slice(0, 32);
}

/** What the established device shows before it agrees to send anything. */
export type ScannedDeviceTransfer = {
  qr: DeviceTransferQrPayload;
  deviceName: string;
  circleCount: number;
};

/**
 * Established-device side, step one. Sends nothing: sealing a seed waits
 * for a button, so it lives in `approveDeviceTransfer` instead.
 */
export async function inspectDeviceTransfer(raw: string): Promise<ScannedDeviceTransfer> {
  const qr = parseQr(raw);
  const tag = deriveDeviceTransferTag(qr.transferCode);

  const id = requesterId(qr.transferCode);
  const row = (await listJoinRequests(tag)).find((request) => request.requesterId === id);
  if (!row) throw new Error('That code has expired or was already used.');

  const request = JSON.parse(
    new TextDecoder().decode(decrypt(row.encryptedRequest, deriveDeviceTransferRequestKey(qr.transferCode))),
  ) as DeviceTransferRequestPayload;

  return { qr, deviceName: request.deviceName || 'that device', circleCount: (await getAllCircles()).length };
}

/** A camera hands over any barcode in view, and this ends up in a key and a URL path. */
function parseQr(raw: string): DeviceTransferQrPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That doesn't look like a Circle transfer code.");
  }

  const { transferCode, ephemeralPublicKey } = (parsed ?? {}) as Partial<DeviceTransferQrPayload>;
  if (typeof transferCode !== 'string' || !/^[0-9A-Z-]{10,32}$/.test(transferCode)) {
    throw new Error("That doesn't look like a Circle transfer code.");
  }
  if (typeof ephemeralPublicKey !== 'string' || !/^[0-9a-f]{64}$/.test(ephemeralPublicKey)) {
    throw new Error("That doesn't look like a Circle transfer code.");
  }
  return { transferCode, ephemeralPublicKey };
}

/** Established-device side, step two. Seals to the QR's key, never one from the relay. */
export async function approveDeviceTransfer(qr: DeviceTransferQrPayload): Promise<void> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');

  const profile = await getProfile();
  const circles: TransferredCircle[] = [];

  for (const circle of await getAllCircles()) {
    const keyMap = await getCircleKeyMap(circle.id);
    const identity = await getCircleIdentity(circle.id);
    // Can't read it here, so it has no business being handed on.
    if (!keyMap || !identity) continue;

    circles.push({
      circleId: circle.id,
      syncId: circle.syncId,
      name: circle.name,
      memberId: identity.memberId,
      keyMap: Object.fromEntries(Object.entries(keyMap).map(([version, key]) => [version, bytesToHex(key)])),
    });
  }

  const payload: DeviceTransferPayload = {
    masterSeed: bytesToHex(masterSeed),
    profile: {
      name: profile?.name ?? '',
      ...(profile?.picture ? { picture: Buffer.from(profile.picture).toString('base64') } : {}),
    },
    circles,
  };

  const sealed = sealToPublicKey(
    new TextEncoder().encode(JSON.stringify(payload)),
    hexToBytes(qr.ephemeralPublicKey),
  );
  await putJoinApproval(deriveDeviceTransferTag(qr.transferCode), requesterId(qr.transferCode), sealed);
}

export type DeviceTransferCheck = { transferred: false } | { transferred: true; circleCount: number };

/**
 * Waiting-device side, step two. Cursors start at zero rather than
 * inheriting the sender's: this device holds no entries yet, and a
 * non-zero cursor would skip straight past all of them.
 */
export async function checkDeviceTransfer(pending: PendingDeviceTransfer): Promise<DeviceTransferCheck> {
  const tag = deriveDeviceTransferTag(pending.transferCode);
  const id = requesterId(pending.transferCode);

  const sealed = await getJoinRequestApproval(tag, id);
  if (!sealed) return { transferred: false };

  const payload = JSON.parse(
    new TextDecoder().decode(openSealedBox(sealed, pending.ephemeralKeypair)),
  ) as DeviceTransferPayload;

  const masterSeed = hexToBytes(payload.masterSeed);
  await saveMasterSeed(masterSeed);

  const now = Date.now();
  await saveProfile({
    name: payload.profile.name,
    picture: payload.profile.picture ? new Uint8Array(Buffer.from(payload.profile.picture, 'base64')) : null,
    createdAt: now,
    updatedAt: now,
  });

  for (const circle of payload.circles) {
    // Re-applying has to be safe: polls overlap, so a slow collect can
    // still be writing when the next one starts. Every other write here
    // overwrites; only the circle row would collide.
    if (await getCircle(circle.circleId)) continue;

    await saveCircleKeyMap(
      circle.circleId,
      Object.fromEntries(Object.entries(circle.keyMap).map(([version, hex]) => [Number(version), hexToBytes(hex)])),
    );
    await saveCircleIdentity(circle.circleId, {
      ...deriveCircleIdentity(masterSeed, circle.circleId),
      memberId: circle.memberId,
    });
    await insertCircle({
      id: circle.circleId,
      name: circle.name,
      picture: null,
      syncId: circle.syncId,
      createdAt: now,
      leftAt: null,
      metaCursor: 0,
      contentCursor: 0,
      lastViewedAt: now,
    });
  }

  // Consumed — no reason to leave a sealed seed sitting out the row's 7-day retention.
  deleteJoinRequest(tag, id).catch((err) => console.error('Failed to clear the transfer row', err));

  return { transferred: true, circleCount: payload.circles.length };
}
