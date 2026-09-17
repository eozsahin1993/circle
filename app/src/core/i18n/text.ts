import type { LanguageCode } from '@/core/i18n/languages';

/**
 * Uppercases for a language, not the device. Turkish has a dotted and a
 * dotless i, so `i` has to become `İ` there. Neither `toUpperCase` nor
 * RN's `textTransform` does that: iOS ignores locale entirely, and Android
 * uses the device's rather than the one picked in the app.
 */
export function upperCase(text: string, language: LanguageCode): string {
  return (language === 'tr' ? text.replace(/i/g, 'İ') : text).toUpperCase();
}
