/** "just now" / "3 minutes ago" / "6 days ago" — the bare phrase, so callers compose their own lead-in ("Last added …"). */
export function formatRelativeTime(pastMs: number): string {
  const minutes = Math.floor((Date.now() - pastMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
