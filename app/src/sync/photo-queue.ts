import {
  getFetchableAttachments,
  markAttachmentFailed,
  markAttachmentFetched,
  type FetchableAttachment,
} from '@/data/db';
import { decrypt, hashBytes } from '@/services/crypto';
import { getCircleKeyMap } from '@/services/keystore';
import { getBlob } from '@/services/relay';

/** First retry waits this long; each further failure doubles it, up to `MAX_BACKOFF_MS`. */
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export type DrainBudget = {
  /** Stop after this many photos. */
  maxPhotos?: number;
  /** Stop once this many milliseconds have elapsed — for a background task's short window. */
  deadlineMs?: number;
};

/** Only one drain runs at a time; a nudge arriving mid-drain is a no-op rather than a second worker. */
let inFlight: Promise<void> | null = null;

function backoffFor(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

/**
 * Downloads one attachment's bytes and stores them, or records the
 * failure and when to try again. Never throws: a failure here is data
 * about that one photo, not a reason to stop the queue.
 */
async function fetchOne(attachment: FetchableAttachment): Promise<void> {
  const { circleId, entryId, hash, keyVersion, fetchAttempts } = attachment;
  try {
    const keyMap = await getCircleKeyMap(circleId);
    const key = keyMap?.[keyVersion];
    if (!key) throw new Error(`no content key for version ${keyVersion}`);

    const encrypted = await getBlob(attachment.syncId, entryId);
    // A blob that isn't there yet is an ordinary race, not corruption:
    // the uploader appends its entry after uploading, but a reader can
    // still arrive between a failed upload and its retry.
    if (!encrypted) throw new Error('blob not found');

    const bytes = decrypt(encrypted, key);
    // The hash rode inside the entry's *signed* payload, so this is what
    // ties the bytes to the author — the entry's signature can't cover a
    // blob uploaded separately (see create-post.ts).
    if (hash && hashBytes(bytes) !== hash) throw new Error('photo hash does not match the signed entry');

    await markAttachmentFetched(circleId, entryId, bytes);
  } catch (err) {
    const attempts = fetchAttempts + 1;
    console.error(`Failed to fetch attachment ${entryId} (attempt ${attempts})`, err);
    await markAttachmentFailed(circleId, entryId, attempts, Date.now() + backoffFor(attempts));
  }
}

async function drain(budget: DrainBudget): Promise<void> {
  const startedAt = Date.now();
  const maxPhotos = budget.maxPhotos ?? Infinity;

  for (let fetched = 0; fetched < maxPhotos; fetched += 1) {
    if (budget.deadlineMs !== undefined && Date.now() - startedAt >= budget.deadlineMs) return;

    // Re-queried every iteration rather than taking a batch up front, so
    // the next photo is always the newest one eligible *right now* — a
    // post landing mid-drain jumps ahead of an older backlog instead of
    // queueing behind a stale snapshot. The backoff filter is also what
    // stops this looping forever on a photo that keeps failing: once
    // marked, it drops out of the query until its retry time.
    const [next] = await getFetchableAttachments(Date.now(), 1);
    if (!next) return;

    await fetchOne(next);
  }
}

/**
 * Asks the photo queue to make progress, and returns immediately —
 * downloads are bulk work that must never sit in front of a log sync or
 * a screen waiting to render.
 *
 * Safe to call from anywhere, as often as you like: if a drain is already
 * running this does nothing, so overlapping triggers (app foreground, a
 * finished sync pass, a periodic tick) collapse into one worker.
 */
export function nudgePhotoQueue(budget: DrainBudget = {}): void {
  if (inFlight) return;

  inFlight = drain(budget)
    .catch((err) => console.error('Photo queue drain failed', err))
    .finally(() => {
      inFlight = null;
    });
}

/** Awaitable drain, for a background task that must not return before its work is done — and for tests. */
export async function drainPhotoQueue(budget: DrainBudget = {}): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = drain(budget).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
