import { i18n } from '@/core/i18n/i18n';

test('plural forms follow each language’s rules', () => {
  expect(i18n.t('time.minutesAgo', { lng: 'en', count: 1 })).toBe('1 minute ago');
  expect(i18n.t('time.minutesAgo', { lng: 'en', count: 0 })).toBe('0 minutes ago');
  // French treats zero as singular.
  expect(i18n.t('time.minutesAgo', { lng: 'fr', count: 0 })).toBe('il y a 0 minute');
});
