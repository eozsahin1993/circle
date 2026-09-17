import { resolveLanguage } from '@/core/i18n/languages';

const device = (...codes: (string | null)[]) => codes.map((languageCode) => ({ languageCode }));

test('a picked language wins over the device', () => {
  expect(resolveLanguage('de', device('tr'))).toBe('de');
});

test('following the device takes its first language the app has', () => {
  expect(resolveLanguage('system', device('it', 'fr', 'tr'))).toBe('fr');
});

test('a device with none of them gets English', () => {
  expect(resolveLanguage('system', device('ja', null))).toBe('en');
});
