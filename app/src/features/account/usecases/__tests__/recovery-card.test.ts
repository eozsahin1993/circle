import { buildRecoveryCard, extractSeedPhrase } from '@/features/account/usecases/recovery-card';
import { generateSeedPhrase } from '@/features/account/crypto';

describe('extractSeedPhrase', () => {
  // The round trip that matters: whatever the card writer produces, the
  // reader gets back. Neither side knows the other's format — the words
  // are found by validating, not by parsing structure.
  test('reads the phrase back out of a card this app wrote', () => {
    const phrase = generateSeedPhrase();

    expect(extractSeedPhrase(buildRecoveryCard(phrase.split(' ')))).toBe(phrase);
  });

  test('reads it out of plain text too, so a pasted email works the same', () => {
    const phrase = generateSeedPhrase();

    expect(extractSeedPhrase(`here are my words:\n\n${phrase}\n\nkeep them safe`)).toBe(phrase);
  });

  // The reason the parser reads the card's list before scanning the whole
  // document. A twelve-word phrase has only a four-bit checksum, so about
  // one window in sixteen validates by chance — and a card's own prose is
  // ordinary English, which is what BIP39 is made of. A window straddling
  // the instructions and the real words will pass sooner or later.
  test('takes the words from their own line, not from wordlist words in the prose', () => {
    const phrase = generateSeedPhrase();
    const decoys = 'able absent absorb abstract absurd abuse access accident account accuse achieve acid';
    const card = buildRecoveryCard(phrase.split(' ')).replace('CIRCLE RECOVERY CARD', `keep ${decoys} safe`);

    expect(extractSeedPhrase(card)).toBe(phrase);
  });

  test('returns null when there is no phrase to find', () => {
    expect(extractSeedPhrase('<p>just a web page about nothing in particular</p>')).toBeNull();
  });

  test('returns null for eleven valid words', () => {
    const eleven = generateSeedPhrase().split(' ').slice(0, 11).join(' ');

    expect(extractSeedPhrase(eleven)).toBeNull();
  });

  // Cards get opened, re-saved, and mangled by whatever handled them in
  // between. Case and punctuation shouldn't decide whether someone gets
  // their account back.
  test('survives the case and punctuation a round trip through other apps adds', () => {
    const phrase = generateSeedPhrase();
    const mangled = phrase
      .split(' ')
      .map((word, index) => (index % 2 ? word.toUpperCase() : word))
      .join(',  ');

    expect(extractSeedPhrase(mangled)).toBe(phrase);
  });
});

describe('buildRecoveryCard', () => {
  test('puts the words on a line of their own, in order', () => {
    const words = generateSeedPhrase().split(' ');

    const lines = buildRecoveryCard(words).split('\n');

    expect(lines).toContain(words.join(' '));
  });

  test('says what the card is, for whoever opens it years later', () => {
    const card = buildRecoveryCard(generateSeedPhrase().split(' '), new Date('2026-09-14'));

    expect(card).toContain('CIRCLE RECOVERY CARD');
    expect(card).toContain('Anyone who has it is you');
    expect(card).toContain('2026-09-14');
  });
});
