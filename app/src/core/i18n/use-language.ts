import { useTranslation } from 'react-i18next';

import type { LanguageCode } from '@/core/i18n/languages';

/**
 * The language on screen, for passing to formatters. A hook so the
 * component re-renders when it changes — see core/utils/time.ts for why
 * formatters take it as an argument rather than reading it themselves.
 */
export function useLanguage(): LanguageCode {
  return useTranslation().i18n.language as LanguageCode;
}
