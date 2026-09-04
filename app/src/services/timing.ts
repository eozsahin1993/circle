import { AppState } from 'react-native';

/**
 * Dev-only phase timing. Everything the sync engine and the feed do runs
 * on the single JS thread, so "which phase is slow" can't be reasoned
 * about from the code — network waits yield, but decryption, signature
 * verification, SQLite and base64 don't, and they compete with rendering.
 *
 * Compiled out of release builds: `__DEV__` is a literal there, so the
 * calls fold away rather than costing a branch per phase.
 */
export async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!__DEV__) return run();

  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    console.log(`⏱ ${label} ${Date.now() - startedAt}ms`);
  }
}

/** The synchronous counterpart, for CPU-bound work that never awaits. */
export function timedSync<T>(label: string, run: () => T): T {
  if (!__DEV__) return run();

  const startedAt = Date.now();
  try {
    return run();
  } finally {
    console.log(`⏱ ${label} ${Date.now() - startedAt}ms`);
  }
}

/**
 * Reports when the JS thread stops responding, which is the only thing
 * the user actually feels. Phase timers can't show this: they measure
 * wall time, so a 300ms network wait and a 300ms blocking loop look
 * identical while only the second one drops taps and frames.
 *
 * A timer set for `TICK_MS` that fires late by more than `JANK_MS` was
 * held up by something synchronous — the overshoot is how long the
 * thread was unavailable. Dev-only, and cheap: one timer, no work per
 * tick beyond a subtraction.
 */
const TICK_MS = 100;
const JANK_MS = 200;

export function startJankMonitor(): () => void {
  if (!__DEV__) return () => {};

  let last = Date.now();
  // Timers also stop while the app is backgrounded, and a dev reload
  // (pressing `r` in Metro) stalls everything for seconds. A gap alone
  // can't tell those apart from a real freeze, and discarding suspicious
  // gaps would hide genuine ones — so report every gap, and say whether
  // the app actually left the foreground during it.
  let leftForeground = false;
  const subscription = AppState.addEventListener('change', (state) => {
    if (state !== 'active') leftForeground = true;
  });

  const interval = setInterval(() => {
    const now = Date.now();
    const blockedFor = now - last - TICK_MS;
    const suspended = leftForeground;
    last = now;
    leftForeground = false;

    if (blockedFor > JANK_MS) {
      console.log(`🧊 JS thread blocked ${blockedFor}ms${suspended ? ' (backgrounded — not a real freeze)' : ''}`);
    }
  }, TICK_MS);

  return () => {
    subscription.remove();
    clearInterval(interval);
  };
}
