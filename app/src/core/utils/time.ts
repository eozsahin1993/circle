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
 *
 * `formatAgo` is the same idea in prose, for somewhere a phrase reads
 * better than a glyph.
 */
export function formatRelative(ms: number): string {
  const elapsed = Date.now() - ms;
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return formatDay(ms);
}

/**
 * The same elapsed time in words — "just now", "3 minutes ago" — where a
 * sentence reads better than `formatRelative`'s "3m". The bare phrase, so
 * callers compose their own lead-in ("Last added …").
 */
export function formatAgo(pastMs: number): string {
  const minutes = Math.floor((Date.now() - pastMs) / MINUTE);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
