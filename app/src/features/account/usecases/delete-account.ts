import AsyncStorage from '@react-native-async-storage/async-storage';
import { bytesToHex } from '@noble/curves/utils.js';

import { sign } from '@/core/crypto/primitives';
import { deriveCircleIdentity } from '@/core/crypto/identity';
import { deriveDeleteAuthorContentMessage } from '@/core/crypto/signed-messages';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { deleteAccountOnRelay, deleteAuthorContentOnRelay } from '@/core/services/log-relay';
import { CircleGoneError } from '@/core/services/relay-errors';
import { getLeftCircles, listCircles } from '@/data/db';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import { fetchAccountManifest } from '@/features/account/usecases/account-manifest';
import { leaveCircleForAccountDeletion } from '@/features/circle/usecases/leave-circle';

/**
 * Set once, at the start of `deleteAccount`, and cleared only once every
 * trace of the account is gone. Kept in AsyncStorage rather than memory —
 * a partial run has to resume across restarts, driven by the sync
 * scheduler like `finishPendingDepartures` already is (see
 * `finishAccountDeletionIfPending`).
 */
const DELETING_KEY = 'account.deletionPending';

async function isAccountDeletionPending(): Promise<boolean> {
  return (await AsyncStorage.getItem(DELETING_KEY)) === '1';
}

async function setAccountDeletionPending(): Promise<void> {
  await AsyncStorage.setItem(DELETING_KEY, '1');
}

async function clearAccountDeletionPending(): Promise<void> {
  await AsyncStorage.removeItem(DELETING_KEY);
}

/**
 * Deletes this account: for every circle still joined, leaves it via
 * `leaveCircleForAccountDeletion` — `leaveCircle`'s account-deletion
 * sibling, which queues one `account_deleted` entry instead of
 * `member_removed` and reuses everything else about leaving unchanged
 * (see its own doc comment). Reused wholesale rather than duplicated,
 * since it already does exactly what account deletion needs from a
 * departure: commit locally right away, keep keys only until the outbox
 * is confirmed drained, resume automatically forever via the sync
 * scheduler.
 *
 * Returns fast: nothing here awaits confirmed delivery, only local
 * writes and outbox enqueues (leaving itself best-effort-pulls meta
 * first, same as any ordinary departure). The actual erasure — this
 * circle's content, circles already left, and the relay account itself
 * — finishes in the background; see `finishAccountDeletionIfPending`.
 */
export async function deleteAccount(): Promise<void> {
  await setAccountDeletionPending();

  for (const circle of await listCircles()) {
    try {
      await leaveCircleForAccountDeletion(circle.id);
    } catch (err) {
      console.error(`Failed to leave circle ${circle.id} while deleting the account`, err);
    }
  }

  finishAccountDeletionIfPending().catch((err) => console.error('Failed to finish account deletion', err));
}

/** Re-derives the departed circle's signing key and strips this identity's content — no write token, no tombstone, nothing to append. */
async function stripDepartedCircleContent(masterSeed: Uint8Array, circleId: string, syncId: string): Promise<void> {
  const identity = deriveCircleIdentity(masterSeed, circleId);
  const message = deriveDeleteAuthorContentMessage(syncId, bytesToHex(identity.publicKey), '');
  await deleteAuthorContentOnRelay(syncId, identity.publicKey, sign(message, identity.secretKey));
}

/**
 * Resumable completion, mirroring `finishPendingDepartures`'s shape —
 * call this alongside it from the sync scheduler so account deletion
 * finishes over as many passes as it takes, restarts included.
 *
 * **Handles only what `deleteAccount`'s own outbox path can't reach.**
 * A currently-joined circle's content is already taken care of: its
 * `account_deleted` tombstone sits in that circle's outbox and drains
 * through the ordinary sync path (`pushAccountDeletion` in
 * `sync-circle.ts`, using the still-valid write token) — nothing here
 * pushes it. What's left for this function is every circle the manifest
 * shows as `leftAt`: no outbox, no write token, no content key anymore,
 * so it needs the signature-only strip instead (idempotent and cheap on
 * an already-stripped circle; a 404 means the circle was deleted for
 * everyone, already done). Once every strip has succeeded *and* every
 * currently-joined circle has finished leaving (`listCircles` and
 * `getLeftCircles` both empty — proof the outbox path above is done
 * too), deletes the relay account itself — the last relay call this
 * account ever makes — then wipes local state and clears the flag.
 */
export function finishAccountDeletionIfPending(): Promise<void> {
  // `deleteAccount` kicks this off fire-and-forget, and the scheduler
  // calls it independently too — the two overlap routinely (deleting the
  // account, then a sync pass lands moments later). A second caller joins
  // the run already in flight instead of duplicating every relay call,
  // same dedup `drainOutbox` uses for the same reason.
  if (inFlightFinish) return inFlightFinish;
  const run = finishAccountDeletionIfPendingOnce().finally(() => {
    inFlightFinish = null;
  });
  inFlightFinish = run;
  return run;
}

let inFlightFinish: Promise<void> | null = null;

async function finishAccountDeletionIfPendingOnce(): Promise<void> {
  if (!(await isAccountDeletionPending())) return;

  const masterSeed = await getMasterSeed();
  if (!masterSeed) {
    // Nothing left to finish with — the wipe already happened somehow.
    await clearAccountDeletionPending();
    return;
  }

  let allStripped = true;
  try {
    const manifest = await fetchAccountManifest();
    for (const circle of manifest.circles ?? []) {
      // A tombstone written before this manifest shape kept a `syncId`
      // (the old two-field `{circleId, leftAt}` shape) has no address to
      // strip — the same honest, deliberate boundary as any other circle
      // left before this feature shipped. Skipped explicitly rather than
      // left to fail: calling the relay with `syncId` missing happens to
      // 404 today, and 404 already means "done" here, but that's an
      // accident of the URL, not something this should depend on.
      if (circle.leftAt === undefined || !circle.syncId) continue;
      try {
        await stripDepartedCircleContent(masterSeed, circle.circleId, circle.syncId);
      } catch (err) {
        if (err instanceof CircleGoneError) continue;
        console.error(`Failed to erase authored content in departed circle ${circle.circleId}`, err);
        allStripped = false;
      }
    }
  } catch (err) {
    console.error('Failed to read the account manifest while finishing account deletion', err);
    allStripped = false;
  }
  if (!allStripped) return;

  if ((await listCircles()).length > 0 || (await getLeftCircles()).length > 0) return;

  try {
    await deleteAccountOnRelay();
  } catch (err) {
    console.error('Failed to delete the relay account', err);
    return;
  }

  await resetLocalDataForTesting();
  await clearAccountDeletionPending();
}
