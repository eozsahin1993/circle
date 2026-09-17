import { i18n } from '@/core/i18n/i18n';
import type { LanguageCode } from '@/core/i18n/languages';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Every formatter takes the language rather than reading i18n's current
// one: the React Compiler caches a call by its arguments, so a hidden input
// would leave a date in the old language after switching.

/** Day without a time — for roster changes, where the hour someone joined is noise. */
export function formatDay(ms: number, language: LanguageCode): string {
  return new Date(ms).toLocaleDateString(language, { month: 'short', day: 'numeric' });
}

/** Day and time — a post's own byline. */
export function formatTimestamp(ms: number, language: LanguageCode): string {
  const time = new Date(ms).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
  return `${formatDay(ms, language)}, ${time}`;
}

/** Month and year — an album section's heading, or when someone joined. */
export function formatMonth(ms: number, language: LanguageCode): string {
  return new Date(ms).toLocaleDateString(language, { month: 'long', year: 'numeric' });
}

/**
 * Short and relative — "3d", "6h" — for a comment sitting under a post
 * that already carries the absolute date. Falls back to that date past a
 * week, where "31d" stops meaning anything.
 *
 * `formatAgo` is the same idea in prose, for somewhere a phrase reads
 * better than a glyph.
 */
export function formatRelative(ms: number, language: LanguageCode): string {
  const t = i18n.getFixedT(language);
  const elapsed = Date.now() - ms;
  if (elapsed < MINUTE) return t('time.now');
  if (elapsed < HOUR) return t('time.minutesShort', { count: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY) return t('time.hoursShort', { count: Math.floor(elapsed / HOUR) });
  if (elapsed < 7 * DAY) return t('time.daysShort', { count: Math.floor(elapsed / DAY) });
  return formatDay(ms, language);
}

/**
 * The same elapsed time in words — "just now", "3 minutes ago" — where a
 * sentence reads better than `formatRelative`'s "3m". The bare phrase, so
 * callers compose their own lead-in ("Last added …").
 */
export function formatAgo(pastMs: number, language: LanguageCode): string {
  const t = i18n.getFixedT(language);
  const minutes = Math.floor((Date.now() - pastMs) / MINUTE);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });
  return t('time.daysAgo', { count: Math.floor(hours / 24) });
}
