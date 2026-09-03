import { AppState, type AppStateStatus } from 'react-native';

import { nudgePhotoQueue } from '@/sync/photo-queue';
import { syncAllCircles } from '@/sync/sync-circles';

/** How often to re-sync while the app is open. Timers don't fire in the background, so this is a foreground cadence. */
const FOREGROUND_INTERVAL_MS = 45_000;

/** Only one log pass at a time; concurrent triggers await the running one instead of starting a second. */
let inFlight: Promise<void> | null = null;

/**
 * Runs a log pass across every circle, then sets the photo queue going
 * without waiting for it.
 *
 * Deduped: the app has several independent reasons to sync (foreground,
 * a timer, a pull-to-refresh, a background task) and they routinely
 * coincide. A second caller joins the pass already running rather than
 * racing it — two concurrent walks would fight over the same cursors.
 */
export function runSync(): Promise<void> {
  if (!inFlight) {
    inFlight = syncAllCircles()
      .catch((err) => console.error('Sync pass failed', err))
      .finally(() => {
        inFlight = null;
      });
  }

  const pass = inFlight;
  // Fire-and-forget: photos must never hold up whatever is awaiting the pass.
  pass.then(() => nudgePhotoQueue());
  return pass;
}

/**
 * Starts the background sync triggers and returns a function that stops
 * them. Call once, from the root layout.
 *
 * Three triggers, all foreground: once on startup, on every return to the
 * foreground (where new content is most likely waiting), and on a timer
 * while the app stays open. iOS has no sync-adapter equivalent, so
 * anything genuinely background is best-effort and additive on top of
 * these, never a replacement for them.
 *
 * Safe to start before sign-in: with no circles `syncAllCircles` is a
 * fast no-op, and without a session each circle's fetch fails and is
 * caught per-circle.
 */
export function startSyncScheduler(): () => void {
  runSync();

  const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') runSync();
  });
  const interval = setInterval(runSync, FOREGROUND_INTERVAL_MS);

  return () => {
    subscription.remove();
    clearInterval(interval);
  };
}
