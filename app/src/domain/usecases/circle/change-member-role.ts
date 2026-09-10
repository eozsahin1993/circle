import { getMemberByPublicKey, MemberRoles, type MemberRole } from '@/data/db';
import { addAuthority, removeAuthority } from '@/domain/usecases/circle/authority';
import { requireAdminPublicKey } from '@/domain/usecases/circle/invite-to-circle';

/**
 * Promotes a member to admin or demotes an admin to member — admin only,
 * and never against yourself: demoting yourself could leave a circle with
 * zero admins if you were the last one, and promoting yourself is
 * meaningless.
 *
 * A promotion registers the promotee's authority key with the relay in
 * the same call that appends the `role_change`. Without that they'd be an
 * admin every client honours and the relay has never heard of — able to
 * approve joins and rename, but not to remove a member, set a cover
 * photo, or delete anyone else's photo. Demotion is the same call in
 * reverse, and has to be: a role stripped on the roster while the key
 * stayed in the set leaves a demoted admin holding every relay power the
 * demotion was meant to take away.
 *
 * Both queue through the outbox, so this works offline. Nothing changes
 * locally until the entry replays back, so the roster can never show an
 * admin the relay refused.
 */
export async function setMemberRole(circleId: string, identityPublicKey: string, role: MemberRole): Promise<void> {
  const ownPublicKey = await requireAdminPublicKey(circleId, "Only an admin can change a member's role.");
  if (identityPublicKey === ownPublicKey) {
    throw new Error("You can't change your own role.");
  }
  const subject = await getMemberByPublicKey(circleId, identityPublicKey);
  if (!subject || subject.removedAt !== null) throw new Error('That person is no longer in this circle.');
  if (subject.role === role) return;

  if (role === MemberRoles.admin) {
    await addAuthority(circleId, subject);
  } else {
    await removeAuthority(circleId, subject);
  }
}
