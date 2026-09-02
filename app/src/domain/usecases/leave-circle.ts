import { deleteCircle, markCircleLeft } from '@/data/db';
import { syncAccountManifestBestEffort } from '@/domain/usecases/account-manifest';
import { isCircleAdmin } from '@/domain/usecases/invite-to-circle';
import { deleteCircleKeys } from '@/services/keystore';

/**
 * Leaves a circle without deleting it locally — already-synced posts stay
 * as a local archive. Wipes this device's identity/secret for the circle
 * so it can't sign new posts or decrypt anything new; rejoining later
 * needs a fresh invite.
 */
export async function leaveCircle(circleId: string): Promise<void> {
  await markCircleLeft(circleId);
  await deleteCircleKeys(circleId);
  await syncAccountManifestBestEffort();
}

/**
 * Deletes a circle entirely on this device — admin only. Only removes
 * this device's own copy; propagating the deletion to every other
 * member's device is relay work (see `deleteCircle`'s doc comment and
 * server/DESIGN.md), not something this can do alone today.
 */
export async function deleteCircleForEveryone(circleId: string): Promise<void> {
  const admin = await isCircleAdmin(circleId);
  if (!admin) throw new Error('Only an admin can delete this circle.');

  await deleteCircle(circleId);
  await deleteCircleKeys(circleId);
  await syncAccountManifestBestEffort();
}
