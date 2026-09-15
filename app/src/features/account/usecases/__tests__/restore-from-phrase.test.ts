jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/mailbox-relay');
jest.mock('@/core/services/log-relay');
jest.mock('@/core/photo/image');
jest.mock('@/core/sync/sync-circles');

import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleBySyncId, getProfile, initDatabase, listCircles, saveProfile } from '@/data/db';
import { fetchAccountManifest } from '@/features/account/usecases/account-manifest';
import { restoreFromPhrase } from '@/features/account/usecases/restore-from-phrase';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import { deriveCircleIdentity } from '@/core/crypto/identity';
import { generateSeedPhrase, seedPhraseToEntropy } from '@/features/account/crypto';
import { getCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { getMasterSeed, saveMasterSeed } from '@/core/services/keystore/master-seed';
import { appendEntry, bootstrapCircle } from '@/core/services/log-relay';

const CONTENT_KEY = new Uint8Array(32).fill(7);

function manifestCircle(circleId: string, syncId: string) {
  return { circleId, syncId, keyMap: { 1: bytesToHex(CONTENT_KEY) } };
}

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (fetchAccountManifest as jest.Mock).mockResolvedValue({
    circles: [manifestCircle('circle-a', 'sync-a'), manifestCircle('circle-b', 'sync-b')],
  });
  await resetLocalDataForTesting();
});

test('a valid phrase restores the seed behind it', async () => {
  const phrase = generateSeedPhrase();

  await expect(restoreFromPhrase(phrase)).resolves.toEqual({ circleCount: 2, name: null });

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

/**
 * The part the seed alone can't do. Content keys are random and unreadable
 * from the log itself, so the manifest's copy is the only one a phrase can
 * reach — without it the circles come back locked.
 */
test('restores every circle in the manifest, with its content keys', async () => {
  await restoreFromPhrase(generateSeedPhrase());

  expect(await listCircles()).toHaveLength(2);
  expect(await getCircleKeyMap('circle-a')).toEqual({ 1: CONTENT_KEY });
  expect(await getCircleKeyMap('circle-b')).toEqual({ 1: CONTENT_KEY });
});

/** Replay rebuilds the roster and the posts; restore only has to leave the cursors at zero. */
test('leaves restored circles at cursor zero so sync replays their whole history', async () => {
  await restoreFromPhrase(generateSeedPhrase());

  const circle = await getCircleBySyncId('sync-a');
  expect(circle).toMatchObject({ metaCursor: 0, contentCursor: 0 });
});

/**
 * Apple only hands back a name on the very first authorization, so a
 * recovered phone has no other way to know it.
 */
test('restores the profile so a returning member is not asked to retype their name', async () => {
  (fetchAccountManifest as jest.Mock).mockResolvedValue({
    circles: [],
    profile: { name: 'Emre', updatedAt: 1_700_000_000 },
  });

  await expect(restoreFromPhrase(generateSeedPhrase())).resolves.toEqual({ circleCount: 0, name: 'Emre' });

  // updatedAt carried over, not stamped now — otherwise this device would
  // outrank a rename made on one that's still running.
  expect(await getProfile()).toMatchObject({ name: 'Emre', updatedAt: 1_700_000_000 });
});

/**
 * A restore that dies partway has already written some circles. Re-running
 * has to resume rather than either refusing outright or replaying the same
 * circle into a second set of rows — `syncId` has no unique index to catch it.
 */
test('running again after a partial restore resumes instead of duplicating', async () => {
  const phrase = generateSeedPhrase();
  await restoreFromPhrase(phrase);

  await expect(restoreFromPhrase(phrase)).resolves.toEqual({ circleCount: 2, name: null });

  expect(await listCircles()).toHaveLength(2);
});

/**
 * A re-run after a partial restore must not undo an edit made in between —
 * the manifest's copy can be the older one by then.
 */
test('leaves a newer local profile alone', async () => {
  (fetchAccountManifest as jest.Mock).mockResolvedValue({
    circles: [],
    profile: { name: 'From the manifest', updatedAt: 100 },
  });
  const phrase = generateSeedPhrase();
  await restoreFromPhrase(phrase);
  await saveProfile({ name: 'Renamed since', picture: null, createdAt: 1, updatedAt: 500 });

  await restoreFromPhrase(phrase);

  expect(await getProfile()).toMatchObject({ name: 'Renamed since', updatedAt: 500 });
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
test('refuses a different seed on a phone that is already in a circle', async () => {
  await saveMasterSeed(seedPhraseToEntropy(generateSeedPhrase()));
  await createCircle({ name: 'Family Circle' });
  const seedBefore = await getMasterSeed();

  await expect(restoreFromPhrase(generateSeedPhrase())).rejects.toThrow('already in a circle');

  expect(await getMasterSeed()).toEqual(seedBefore);
});

/** Offline is not a reason to reject words that are perfectly valid. */
test('an unreachable relay still restores, just without the circles', async () => {
  (fetchAccountManifest as jest.Mock).mockRejectedValue(new Error('offline'));
  const phrase = generateSeedPhrase();

  await expect(restoreFromPhrase(phrase)).resolves.toEqual({ circleCount: null, name: null });

  expect(await getMasterSeed()).toEqual(seedPhraseToEntropy(phrase));
});
