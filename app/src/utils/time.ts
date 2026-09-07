const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Day without a time — for roster changes, where the hour someone joined is noise. */
export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Day and time — a post's own byline. */
export function formatTimestamp(ms: number): string {
  const time = new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${formatDay(ms)}, ${time}`;
}

/**
 * Short and relative — "3d", "6h" — for a comment sitting under a post
 * that already carries the absolute date. Falls back to that date past a
 * week, where "31d" stops meaning anything.
 */
export function formatRelative(ms: number): string {
  const elapsed = Date.now() - ms;
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return formatDay(ms);
}
