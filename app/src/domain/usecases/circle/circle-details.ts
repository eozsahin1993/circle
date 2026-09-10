import { bytesToHex } from '@noble/curves/utils.js';

import { circlePushPreferences, type CirclePushPreferences } from '@/domain/usecases/push/push-preferences';

import {
  getCircleMembers,
  getCircleSummary,
  getCurrentInvite,
  type CircleListRow,
  type Invite,
  type Member,
} from '@/data/db';
import { isCircleAdmin } from '@/domain/usecases/circle/invite-to-circle';
import { getCircleIdentity } from '@/services/keystore';

export type CircleDetails = {
  circle: CircleListRow | null;
  members: Member[];
  ownIsAdmin: boolean;
  /** Null in the gap between joining and that join completing. */
  ownPublicKey: string | null;
  /**
   * The live invite, read rather than minted — opening this screen
   * shouldn't create a key, or write an invite preview to the relay, for
   * an admin who only came to look at the roster.
   */
  invite: Invite | null;
  /** Which notifications this circle sends — see push-preferences.ts. */
  push: CirclePushPreferences;
};

/**
 * The details screen's whole read, mirroring `loadCircleFeed` — local
 * database only, and data rather than view models.
 */
export async function loadCircleDetails(circleId: string): Promise<CircleDetails> {
  const [circle, members, ownIsAdmin, identity, invite] = await Promise.all([
    getCircleSummary(circleId),
    getCircleMembers(circleId),
    isCircleAdmin(circleId),
    getCircleIdentity(circleId),
    getCurrentInvite(circleId),
  ]);

  return {
    circle,
    members,
    ownIsAdmin,
    ownPublicKey: identity ? bytesToHex(identity.publicKey) : null,
    invite,
    push: await circlePushPreferences(circleId),
  };
}
