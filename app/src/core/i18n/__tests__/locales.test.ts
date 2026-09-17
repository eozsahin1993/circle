import de from '@/core/i18n/locales/de.json';
import en from '@/core/i18n/locales/en.json';
import es from '@/core/i18n/locales/es.json';
import fr from '@/core/i18n/locales/fr.json';
import tr from '@/core/i18n/locales/tr.json';

/**
 * English is the source; every other file must match it key for key, so a
 * returned translation can't silently fall back to English or lose a value.
 *
 * Plural keys follow English's `_one`/`_other`. French and Spanish also have
 * a `many` form, used only from a million up, and fall back to English
 * there — no count in this app gets that high.
 */

type Strings = { [key: string]: string | Strings };

function flatten(strings: Strings, prefix = ''): Record<string, string> {
  return Object.entries(strings).reduce<Record<string, string>>((flat, [key, value]) => {
    const path = prefix + key;
    return typeof value === 'string' ? { ...flat, [path]: value } : { ...flat, ...flatten(value, `${path}.`) };
  }, {});
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((match) => match[1]).sort();
}

const source = flatten(en);

describe.each([
  ['tr', tr],
  ['es', es],
  ['fr', fr],
  ['de', de],
])('%s', (_, strings) => {
  const translated = flatten(strings);

  test('has exactly the keys English has', () => {
    expect(Object.keys(translated).sort()).toEqual(Object.keys(source).sort());
  });

  // A singular may say "the comment" rather than "1 comment", so `_one` alone may leave out the count.
  test('keeps every placeholder, and adds none', () => {
    for (const key of Object.keys(source)) {
      const expected = placeholders(source[key]).filter((name) => !(key.endsWith('_one') && name === 'count'));
      const actual = placeholders(translated[key] ?? '').filter((name) => !(key.endsWith('_one') && name === 'count'));
      expect([key, actual]).toEqual([key, expected]);
    }
  });

  // Only `<name>`, the feed's styled "you", is understood; anything else would show its brackets.
  test('uses no markup but whole <name> tags', () => {
    for (const [key, text] of Object.entries(translated)) {
      expect([key, text.replace(/<name>[^<>]*<\/name>/g, '')]).toEqual([key, expect.not.stringMatching(/[<>]/)]);
    }
  });

  test('leaves nothing empty', () => {
    expect(Object.keys(translated).filter((key) => !translated[key].trim())).toEqual([]);
  });
});
