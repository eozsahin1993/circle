import { bytesToHex } from '@noble/curves/utils.js';

import {
  getCircleMembers,
  getMemberByPublicKey,
  insertOutboxEntry,
  MemberRoles,
  OutboxStatuses,
  type Member,
  type MemberRole,
  type OutboxAuthorityAction,
} from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/domain/usecases/circle/log-entry';
import { drainOutbox } from '@/domain/usecases/circle/sync-circle';
import { AuthorityActions, generateUUID } from '@/services/crypto';
import { getCircleIdentity, getCurrentContentKey } from '@/services/keystore';

/**
 * The relay's authority set decides who may rotate a key, set a cover
 * photo, or delete someone else's photo. This module is the only thing
 * that moves keys in or out of it.
 *
 * `role === admin` and "in the relay's set" mean the same thing: every
 * member publishes their key on `member_added`, every change commits the
 * `role_change` entry and the set mutation in one relay transaction, and
 * the role is written only when that entry replays. So the rest of the app
 * reasons about roles alone.
 *
 * A key only gets in by being named by a key already in it, so a circle's
 * authority always traces back to the founder's bootstrap.
 */

/** Promotes `subject`, putting their authority key into the relay's set. */
export async function addAuthority(circleId: string, subject: Member): Promise<void> {
  await queueRoleChange(circleId, subject.identityPublicKey, subject.authorityPublicKey, MemberRoles.admin, AuthorityActions.add);
}

/** Demotes `subject`, taking their authority key back out of the relay's set. */
export async function removeAuthority(circleId: string, subject: Member): Promise<void> {
  await queueRoleChange(circleId, subject.identityPublicKey, subject.authorityPublicKey, MemberRoles.member, AuthorityActions.remove);
}

/**
 * Hands this device's authority back on the way out of a circle: promotes
 * a successor if it is the last admin, then queues the removal of its own
 * key.
 *
 * Both halves have to be queued before the departure entry, and in this
 * order. The relay refuses a removal that would empty the authority set,
 * so the successor must land first; and `finishDeparture` wipes this
 * device's keys the moment the departure is through, after which nothing
 * can ever sign this key out of the set again.
 *
 * Leaving is never blocked on any of it: a circle with no eligible
 * successor is left ungovernable rather than inescapable.
 */
export async function queueDepartingHandover(circleId: string): Promise<void> {
  const own = await ownMember(circleId);
  if (!own || own.role !== MemberRoles.admin) return;

  if ((await otherAdmins(circleId)).length === 0) {
    const successor = (await handoverCandidates(circleId))[0];
    if (successor) {
      await addAuthority(circleId, successor);
    } else if ((await getCircleMembers(circleId)).length > 1) {
      // Only worth saying when somebody is actually left behind: the last
      // member out isn't stranding anyone.
      console.error(`Leaving circle ${circleId} with nobody able to take over — no remaining member has a usable authority key.`);
    }
  }

  await removeAuthority(circleId, own);
}

/**
 * Who `queueDepartingHandover` would promote if this device left now, or
 * null if nobody would need to take over — named in the leave
 * confirmation, so the consequence is visible before it happens.
 */
export async function departingSuccessor(circleId: string): Promise<Member | null> {
  const own = await ownMember(circleId);
  if (!own || own.role !== MemberRoles.admin) return null;
  if ((await otherAdmins(circleId)).length > 0) return null;
  return (await handoverCandidates(circleId))[0] ?? null;
}

/**
 * Members who could be handed authority, longest-tenured first
 * (`getCircleMembers` is already in join order), so an automatic handover
 * lands on whoever has been around longest.
 *
 * Filtered on actually holding a key: an add naming an empty one is
 * refused, and a refused row at the head of the outbox blocks the
 * departure queued behind it. Every member carries a key from
 * `member_added`, so this only skips a failed proof of possession.
 */
async function handoverCandidates(circleId: string): Promise<Member[]> {
  const ownPublicKey = (await ownMember(circleId))?.identityPublicKey ?? '';
  return (await getCircleMembers(circleId)).filter(
    (member) => member.identityPublicKey !== ownPublicKey && member.authorityPublicKey !== ''
  );
}

/** Admins other than this device — whoever could still govern the circle if this device stopped. */
async function otherAdmins(circleId: string): Promise<Member[]> {
  const ownPublicKey = (await ownMember(circleId))?.identityPublicKey ?? '';
  return (await getCircleMembers(circleId)).filter(
    (member) => member.role === MemberRoles.admin && member.identityPublicKey !== ownPublicKey
  );
}

async function ownMember(circleId: string): Promise<Member | null> {
  const identity = await getCircleIdentity(circleId);
  return identity ? getMemberByPublicKey(circleId, bytesToHex(identity.publicKey)) : null;
}

/**
 * Queues the `role_change` every promotion and demotion writes, tagged so
 * the drain sends it down the endpoint that commits the set mutation and
 * the entry together (see `authorityAction` on the outbox schema).
 *
 * Queued rather than called straight out so this works offline, like
 * every other meta write. Nothing local changes yet: the relay can refuse
 * an authority change, so the entry replaying back is the single writer
 * for the role.
 */
async function queueRoleChange(
  circleId: string,
  identityPublicKey: string,
  authorityPublicKey: string,
  role: MemberRole,
  action: OutboxAuthorityAction
): Promise<void> {
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const entry = buildAndEncryptLogEntry(
    EntryTypes.ROLE_CHANGE,
    { identityPublicKey, role, createdAt: Date.now() },
    identity,
    current.key
  );
  await insertOutboxEntry({
    circleId,
    entryType: EntryTypes.ROLE_CHANGE,
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    blobEntryId: null,
    encryptedMeta: entry,
    authorityAction: action,
    authorityTargetKey: authorityPublicKey,
  });

  drainOutbox(circleId).catch((err) => console.error('Failed to push role_change', err));
}
