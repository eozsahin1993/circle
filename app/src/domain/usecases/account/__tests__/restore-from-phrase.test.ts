jest.mock('@/domain/usecases/circle/sync-circle');
jest.mock('@/domain/usecases/account/account-manifest');
jest.mock('@/services/mailbox-relay');
jest.mock('@/services/relay');
jest.mock('@/services/image');

import { initDatabase } from '@/data/db';
import { fetchAccountManifest } from '@/domain/usecases/account/account-manifest';
import { restoreFromPhrase } from '@/domain/usecases/account/restore-from-phrase';
import { createCircle } from '@/domain/usecases/circle/create-circle';
import { resetLocalDataForTesting } from '@/domain/usecases/dev-reset';
import { deriveCircleIdentity, generateSeedPhrase, seedPhraseToEntropy } from '@/services/crypto';
import { getMasterSeed, saveMasterSeed } from '@/services/keystore';
import { appendEntry, bootstrapCircle } from '@/services/relay';

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (fetchAccountManifest as jest.Mock).mockResolvedValue({ circleIds: ['a', 'b'] });
  await resetLocalDataForTesting();
});

test('a valid phrase restores the seed behind it', async () => {
  const phrase = generateSeedPhrase();

  await expect(restoreFromPhrase(phrase)).resolves.toEqual({ circleCount: 2 });

  expect(await getMasterSeed()).toEqual(seedPhraseToEntropy(phrase));
});

/**
 * The whole point of the phrase: you come back as the same member rather
 * than a stranger, because circle identities are derived from the seed.
 */
test('the restored seed regenerates the identity the roster already knows', async () => {
  const phrase = generateSeedPhrase();
  const seed = seedPhraseToEntropy(phrase);
  const before = deriveCircleIdentity(seed, 'circle-1');

  await restoreFromPhrase(phrase);

  expect(deriveCircleIdentity((await getMasterSeed())!, 'circle-1')).toEqual(before);
});

test.each([
  ['a mistyped word', 'wolf ladder among zzzznotaword pause frost cabin ridge amber vault clay ember'],
  ['too few words', 'wolf ladder among'],
  ['nothing at all', '   '],
])('%s is rejected and leaves no seed behind', async (_label, phrase) => {
  await expect(restoreFromPhrase(phrase)).rejects.toThrow();

  expect(await getMasterSeed()).toBeNull();
});

test('extra spacing and capitals still restore', async () => {
  const phrase = generateSeedPhrase();

  await restoreFromPhrase(`  ${phrase.toUpperCase().split(' ').join('   ')}  `);

  expect(await getMasterSeed()).toEqual(seedPhraseToEntropy(phrase));
});

/** Adopting another seed would file the existing circle's keys under an identity it can't reproduce. */
test('refuses to run on a phone that is already in a circle', async () => {
  await saveMasterSeed(seedPhraseToEntropy(generateSeedPhrase()));
  await createCircle({ name: 'Family Circle' });
  const seedBefore = await getMasterSeed();

  await expect(restoreFromPhrase(generateSeedPhrase())).rejects.toThrow('already in a circle');

  expect(await getMasterSeed()).toEqual(seedBefore);
});

/** Offline is not a reason to reject words that are perfectly valid. */
test('an unreachable relay still restores, just without a circle count', async () => {
  (fetchAccountManifest as jest.Mock).mockRejectedValue(new Error('offline'));
  const phrase = generateSeedPhrase();

  await expect(restoreFromPhrase(phrase)).resolves.toEqual({ circleCount: null });

  expect(await getMasterSeed()).toEqual(seedPhraseToEntropy(phrase));
});
