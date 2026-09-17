import 'i18next';

import type en from '@/core/i18n/locales/en.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
  }
}
