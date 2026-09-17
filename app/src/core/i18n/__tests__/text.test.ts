import { upperCase } from '@/core/i18n/text';

test('Turkish keeps the dot on a capital i', () => {
  expect(upperCase('eyl 17 · istanbul', 'tr')).toBe('EYL 17 · İSTANBUL');
});

test('other languages uppercase i plainly', () => {
  expect(upperCase('sept 17', 'fr')).toBe('SEPT 17');
});
