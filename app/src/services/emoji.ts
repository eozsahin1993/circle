import emojiRegex from 'emoji-regex';

/**
 * Whether `value` is exactly one emoji, once trimmed — including compound
 * sequences (family/profession ZWJ emoji, flags, skin-tone modifiers),
 * which are multiple Unicode code points but a single visual glyph.
 * Deliberately regex-based (not `Intl.Segmenter`) since Hermes's support
 * for that API hasn't been confirmed.
 */
export function isSingleEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  const matches = Array.from(trimmed.matchAll(emojiRegex()));
  return matches.length === 1 && matches[0][0] === trimmed;
}
