import { bytesToHex } from '@noble/curves/utils.js';

import {
  discardPendingOutboxEntries,
  getCircle,
  getCircleMembers,
  getLeftCircles,
  getPendingOutboxEntries,
  insertOutboxEntry,
  markCircleLeft,
  OutboxStatuses,
  recordMemberRemovedLocally,
  type OutboxEntry,
} from '@/data/db';
import { removeCircleNotificationChannel } from '@/features/push-notifications/services/channels';
import { recordInManifestBestEffort } from '@/features/account/usecases/account-manifest';
import { queueDepartingHandover } from '@/features/circle/usecases/authority';
import { purgeCircleLocally } from '@/features/circle/usecases/purge-circle';
import { buildAndEncryptLogEntry, EntryTypes } from '@/core/sync/log-entry';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { generateUUID } from '@/core/crypto/primitives';
import { getCircleIdentity, getCurrentContentKey, type CircleIdentity } from '@/core/services/keystore/circle-keys';
import { pullMeta } from '@/core/sync/pull-log';

/**
 * Leaves a circle without deleting it locally. The rows stay, but nothing
 * surfaces them: every circle-list query filters on `leftAt IS NULL`, so
 * a left circle is invisible rather than an archive. Whether they should
 * be deleted outright is undecided.
 *
 * **Leaving is announced on the log.** A `member_removed` naming this
 * device's own identity, signed by it, is queued for the relay. Without
 * it a departure was purely local and invisible: everyone else kept the
 * leaver on their roster and in the member count forever, and — worse —
 * kept wrapping every new content key to them on each rotation, since
 * `removeMember` builds its wrap list from `getCircleMembers`.
 *
 * **Works offline.** The entry goes through the outbox like a post, so
 * leaving is instant and local; the push happens on the next pass with a
 * connection. That's also why the keys survive this function: pushing
 * needs a write token derived from the current content key, and
 * `pushPendingEntries` derives it at drain time. `finishDeparture` is
 * what eventually wipes them, once the entry has actually landed.
 *
 * No key rotation, unlike `removeMember`. Someone walking out on their
 * own isn't the threat rotation defends against, and rotating here would
 * let any member churn the whole circle's keys at will — and force every
 * remaining device to re-wrap, on the say-so of someone who just left.
 *
 * The matching `member_events` row is written on the *other* devices,
 * when they pull this entry back. This one never sees it: it stops
 * syncing the circle once the departure has gone out, so its own archive
 * keeps the roster as it stood, minus itself.
 *
 * **Authority is handed back first** — see `queueDepartingHandover`.
 */
export async function leaveCircle(circleId: string): Promise<void> {
  await departFromCircle(circleId, EntryTypes.MEMBER_REMOVED, (identity, currentKey, occurredAt) =>
    buildAndEncryptLogEntry(
      EntryTypes.MEMBER_REMOVED,
      // Carried on the entry for the same reason member_added carries
      // theirs — so a device replaying meta from epoch 0 dates this
      // departure when it happened, not when it read about it. Doubly so
      // here, where the gap can be days of being offline.
      { identityPublicKey: bytesToHex(identity.publicKey), createdAt: occurredAt },
      identity,
      currentKey
    )
  );
}

/**
 * `leaveCircle`'s account-deletion sibling: queues one `account_deleted`
 * entry instead of `member_removed`. It replaces that departure entirely
 * rather than running alongside it — `account_deleted` already carries
 * everything a departure needs to announce (see `account-deleted.ts`) —
 * so there is never a separate `member_removed` for this circle too.
 *
 * Everything else about leaving is unrelated to *why* this device is
 * leaving, so `departFromCircle` runs it unchanged: the last member out
 * still deletes the circle instead of departing it
 * (`deleteCircleForEveryone` — its own tombstone-and-sweep already
 * erases everything, so a redundant `account_deleted` there would add
 * nothing), and an admin still hands off authority before giving up
 * their own key.
 */
export async function leaveCircleForAccountDeletion(circleId: string): Promise<void> {
  await departFromCircle(circleId, EntryTypes.ACCOUNT_DELETED, (identity, currentKey, occurredAt) =>
    buildAndEncryptLogEntry(EntryTypes.ACCOUNT_DELETED, { createdAt: occurredAt }, identity, currentKey)
  );
}

/**
 * The shared shape behind `leaveCircle` and `leaveCircleForAccountDeletion`
 * — everything about leaving except which one entry announces it and
 * what that entry's payload holds. `entryType`/`buildEntry` are the only
 * per-caller pieces; the solo-member check, the handover, the local
 * optimistic write, and the background push are identical regardless of
 * why the departure is happening.
 */
async function departFromCircle(
  circleId: string,
  entryType: OutboxEntry['entryType'],
  buildEntry: (identity: CircleIdentity, currentKey: Uint8Array, occurredAt: number) => Uint8Array
): Promise<void> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('No local circle row for this id.');
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');
  if (!(await getCurrentContentKey(circleId))) throw new Error('No content key on this device.');

  // A stale roster hands the circle to someone who already left, and the
  // relay reads no rosters. Best-effort: leaving can't need a connection.
  const caughtUp = await pullMeta(circleId).then(
    () => true,
    (err) => {
      console.error(`Leaving circle ${circleId} without catching up on meta first`, err);
      return false;
    }
  );

  // The pull may have carried this device's own removal, which already
  // tore the circle down — the departure it was about to announce.
  const current = await getCurrentContentKey(circleId);
  if (!current) return;

  // Only on a roster known to be current: offline, "nobody else is here"
  // may just mean this device never saw the last person join, and deleting
  // on that would take the circle from members it doesn't know about.
  if (caughtUp && (await getCircleMembers(circleId)).length === 1) {
    await deleteCircleForEveryone(circleId);
    return;
  }

  // The outbox drains in order, so the handover has to be queued ahead of
  // the departure to reach the relay while this device can still sign it.
  await queueDepartingHandover(circleId);

  const occurredAt = Date.now();
  await insertOutboxEntry({
    circleId,
    entryType,
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    blobEntryId: null,
    encryptedMeta: buildEntry(identity, current.key, occurredAt),
  });

  await recordMemberRemovedLocally({ circleId, subjectPublicKey: bytesToHex(identity.publicKey), removedAt: occurredAt });
  await markCircleLeft(circleId);
  // Deleting the group takes its channels with it.
  await removeCircleNotificationChannel(circleId);
  await recordInManifestBestEffort();

  finishDeparture(circleId).catch((err) => console.error('Failed to push departure', err));
}

/**
 * Pushes a queued departure and, once it has landed, finally wipes this
 * device's keys for the circle. Safe to call repeatedly and on a circle
 * with nothing outstanding — that's how the scheduler drives it.
 *
 * `pullMeta` runs first for the same reason `syncCircle` does it: a
 * rotation this device hasn't seen would bounce the append, and while
 * offline someone may well have rotated. It has a second job here — if
 * an admin removed this member in the meantime, that entry tears the
 * circle down on arrival, and the queued departure becomes both
 * impossible to sign and pointless, since the removal it was announcing
 * has already happened. Hence the key check after the pull, not just
 * before.
 */
export async function finishDeparture(circleId: string): Promise<void> {
  if (!(await getCurrentContentKey(circleId))) {
    await discardPendingOutboxEntries(circleId);
    return;
  }

  await pullMeta(circleId);

  if (!(await getCurrentContentKey(circleId))) {
    await discardPendingOutboxEntries(circleId);
    return;
  }

  await drainOutbox(circleId);

  // Still queued means the push failed — leave everything alone and let
  // the next pass retry. Only a clean outbox proves the circle has heard.
  if ((await getPendingOutboxEntries(circleId)).length > 0) return;

  await purgeCircleLocally(circleId);
}

/**
 * Ends a circle for everyone — the last member's exit, not an admin's
 * decision about anyone else's copy. What makes it safe is that there is
 * nobody left whose photos it destroys but their own.
 *
 * Queued like a departure, so it works offline and the local teardown
 * waits on the relay: `finishDeparture` tears this device down once the
 * tombstone lands, and every other device does the same on replaying it.
 */
export async function deleteCircleForEveryone(circleId: string): Promise<void> {
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const entry = buildAndEncryptLogEntry(EntryTypes.CIRCLE_DELETED, { createdAt: Date.now() }, identity, current.key);
  await insertOutboxEntry({
    circleId,
    entryType: EntryTypes.CIRCLE_DELETED,
    entryId: generateUUID(),
    status: OutboxStatuses.pending,
    epoch: null,
    blobEntryId: null,
    encryptedMeta: entry,
  });

  await markCircleLeft(circleId);
  await removeCircleNotificationChannel(circleId);
  await recordInManifestBestEffort();

  finishDeparture(circleId).catch((err) => console.error('Failed to push circle deletion', err));
}

/**
 * Finishes every departure still outstanding on this device. Called by
 * the sync scheduler, since `getAllCircles` — what every other sync path
 * walks — deliberately excludes circles this device has left.
 *
 * One failure doesn't stop the rest, the same way `syncAllCircles`
 * contains a failure to its own circle.
 */
export async function finishPendingDepartures(): Promise<void> {
  for (const circle of await getLeftCircles()) {
    if ((await getPendingOutboxEntries(circle.id)).length === 0) continue;
    try {
      await finishDeparture(circle.id);
    } catch (err) {
      console.error(`Failed to finish leaving circle ${circle.id}`, err);
    }
  }
}
