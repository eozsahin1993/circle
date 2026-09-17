/**
 * The languages the app is translated into. Names are each language's own,
 * so someone stuck in one they can't read can still find theirs.
 */
export const Languages = [
  { code: 'en', name: 'English' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
] as const;

export type LanguageCode = (typeof Languages)[number]['code'];

/** What's stored: a language, or following the device. */
export type LanguagePreference = 'system' | LanguageCode;

export const FALLBACK_LANGUAGE: LanguageCode = 'en';

export function isLanguageCode(value: unknown): value is LanguageCode {
  return Languages.some((language) => language.code === value);
}

/**
 * The language to show. For 'system', the first of the device's languages
 * the app has — someone with Turkish then English gets Turkish, someone
 * with Italian then German gets German.
 */
export function resolveLanguage(
  preference: LanguagePreference,
  deviceLocales: readonly { languageCode: string | null }[],
): LanguageCode {
  if (preference !== 'system') return preference;
  return deviceLocales.map((locale) => locale.languageCode).find(isLanguageCode) ?? FALLBACK_LANGUAGE;
}
