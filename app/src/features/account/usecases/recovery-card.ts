import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { seedPhraseToEntropy } from '@/features/account/crypto';
import { getMasterSeed } from '@/core/services/keystore/master-seed';

const PHRASE_LENGTH = 12;

/**
 * A file someone saves once and hands back later, instead of twelve words
 * they have to transcribe and retype.
 *
 * Plain text on purpose: it opens on anything, survives being mailed to
 * yourself and re-saved, and there is no format to be stuck with. The
 * words sit on their own line so the reader can find them exactly — see
 * `extractSeedPhrase` for why that line matters more than it looks.
 */
export function buildRecoveryCard(words: string[], savedOn = new Date()): string {
  return [
    'CIRCLE RECOVERY CARD',
    '',
    'This file restores your account on a new phone.',
    'Anyone who has it is you, so keep it somewhere only you can reach.',
    '',
    'To use it: open Circle, sign in, and choose "I have a recovery card".',
    '',
    words.join(' '),
    '',
    `Saved ${savedOn.toISOString().slice(0, 10)}`,
    '',
  ].join('\n');
}

/**
 * Writes the card and hands it to the OS share sheet, which is where the
 * destinations people actually keep things live — Files, iCloud Drive,
 * Drive, mail, print. Never sent anywhere by us: a phrase the relay
 * transmits is a phrase the relay saw.
 *
 * Returns false when the platform has no way to share, so the caller can
 * say something rather than appearing to do nothing.
 */
export async function saveRecoveryCard(): Promise<boolean> {
  const seed = await getMasterSeed();
  if (!seed) throw new Error('No master seed on this device.');

  const card = buildRecoveryCard(entropyToMnemonic(seed, wordlist).split(' '));
  const file = new File(Paths.cache, 'circle-recovery-card.txt');
  file.create({ overwrite: true });
  file.write(card);

  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', UTI: 'public.plain-text' });
  return true;
}

/**
 * Pulls the phrase back out of whatever the person picked — a card this
 * app wrote, a note they keep, an email they pasted.
 *
 * A line holding nothing but twelve words is tried before anything else,
 * and that ordering is load-bearing. A twelve-word phrase carries only a
 * **four-bit** checksum, so roughly one arbitrary twelve-word window in
 * sixteen validates — and the card's own instructions are ordinary
 * English, which is exactly what BIP39 is made of. Scanning the whole
 * document first would eventually return a window straddling the prose
 * and the real words. The dedicated line makes the common case exact; the
 * scan is the fallback for text with no such line.
 */
export function extractSeedPhrase(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const phrase = findPhrase(line);
    if (phrase && line.trim().split(/\s+/).length === PHRASE_LENGTH) return phrase;
  }
  return findPhrase(text);
}

function findPhrase(text: string): string | null {
  const words = text
    .replace(/<[^>]*>/g, ' ')
    .toLowerCase()
    .match(/[a-z]+/g);
  if (!words) return null;

  for (let start = 0; start + PHRASE_LENGTH <= words.length; start++) {
    const candidate = words.slice(start, start + PHRASE_LENGTH);
    if (!candidate.every((word) => wordlist.includes(word))) continue;
    try {
      seedPhraseToEntropy(candidate.join(' '));
      return candidate.join(' ');
    } catch {
      // In the wordlist but failed the checksum — keep sliding.
    }
  }
  return null;
}

/** The phrase from a card the person picks, or null if they cancelled. Throws if the file holds no valid one. */
export async function pickRecoveryCard(): Promise<string | null> {
  const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
  if (picked.canceled || !picked.assets?.[0]) return null;

  const phrase = extractSeedPhrase(await new File(picked.assets[0].uri).text());
  if (!phrase) throw new Error("That file doesn't have a recovery phrase in it.");
  return phrase;
}
