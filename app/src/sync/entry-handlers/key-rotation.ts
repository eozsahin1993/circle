import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';

import { getCircleMembers, MemberRoles } from '@/data/db';
import { deriveCircleSealingKeypair, openSealedBox } from '@/services/crypto';
import { addCircleKeyVersion, getCircleIdentity, getMasterSeed } from '@/services/keystore';
import { asRecord, numberField, type EntryHandler } from '@/sync/entry-handlers/types';

/** What `remove-member.ts` puts in a `key_rotation` entry — one wrap per remaining member, keyed by their identityPublicKey. */
type KeyRotationPayload = {
  version: number;
  /** hex(sealToPublicKey(newContentKey, member.encPublicKey)), keyed by member.identityPublicKey (hex). */
  wraps: Record<string, string>;
};

function parse(payload: unknown): KeyRotationPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const version = numberField(record, 'version');
  if (version === null) return null;

  const wrapsField = record.wraps;
  if (typeof wrapsField !== 'object' || wrapsField === null) return null;
  const wraps: Record<string, string> = {};
  for (const [identityPublicKey, sealed] of Object.entries(wrapsField)) {
    if (typeof sealed !== 'string') return null;
    wraps[identityPublicKey] = sealed;
  }
  return { version, wraps };
}

export const keyRotationHandler: EntryHandler = {
  /** Same admin-at-that-point-in-meta's-order rule as `member_removed`/`role_change`. */
  async predicate(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return false;

    const admins = (await getCircleMembers(circleId)).filter((member) => member.role === MemberRoles.admin);
    return admins.some((member) => member.identityPublicKey === envelope.authorPubkey);
  },

  /**
   * Opens this device's own wrap, if any, and stores the key. A missing
   * wrap (this device was the one removed, or wasn't a member yet) is a
   * no-op, not an error — omission from `wraps` is the revocation.
   *
   * The try/catch matters: pull-log.ts only treats SQLite constraint
   * violations as safe to skip, so a decode/decrypt error here would
   * otherwise wedge the sync pass instead of just skipping this entry.
   */
  async apply(circleId, envelope) {
    const payload = parse(envelope.payload);
    if (!payload) return;

    const identity = await getCircleIdentity(circleId);
    if (!identity) return;

    const ownWrap = payload.wraps[bytesToHex(identity.publicKey)];
    if (!ownWrap) return;

    const masterSeed = await getMasterSeed();
    if (!masterSeed) return;

    let key: Uint8Array;
    try {
      const sealingKeypair = deriveCircleSealingKeypair(masterSeed, circleId);
      key = openSealedBox(hexToBytes(ownWrap), sealingKeypair);
    } catch (err) {
      console.error('Failed to open this device\'s key_rotation wrap', err);
      return;
    }

    await addCircleKeyVersion(circleId, payload.version, key);
  },
};
