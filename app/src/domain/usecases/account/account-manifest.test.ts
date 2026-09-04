jest.mock('@/services/relay');

import { getAllCircles, initDatabase, insertCircle } from '@/data/db';
import { decrypt, deriveManifestKey, encryptJSON } from '@/services/crypto';
import {
  fetchAccountManifest,
  ForeignManifestError,
  recordSignInProviderBestEffort,
  syncAccountManifest,
  syncAccountManifestBestEffort,
} from '@/domain/usecases/account/account-manifest';
import { getManifest, putManifest } from '@/services/relay';
import { deleteMasterSeed, saveMasterSeed } from '@/services/keystore';

beforeAll(() => initDatabase());
// resetAllMocks, not clearAllMocks — a mockResolvedValue left over from a
// previous test (e.g. getManifest returning a blob encrypted under a
// different test's seed) would otherwise leak in and fail to decrypt,
// masking what each test actually means to exercise.
beforeEach(() => jest.resetAllMocks());

async function addCircle(id: string) {
  await insertCircle({ id, name: id, picture: null, syncId: `sync-${id}`, createdAt: Date.now(), leftAt: null, metaCursor: 0, contentCursor: 0 });
}

describe('syncAccountManifest', () => {
  test('is a no-op before a master seed exists', async () => {
    await deleteMasterSeed();

    await syncAccountManifest();

    expect(putManifest).not.toHaveBeenCalled();
  });

  test('encrypts the current circleId list and pushes it', async () => {
    await saveMasterSeed(new Uint8Array(16).fill(1));
    await addCircle('circle-a');
    await addCircle('circle-b');

    await syncAccountManifest();

    expect(putManifest).toHaveBeenCalledTimes(1);
    const [blob] = (putManifest as jest.Mock).mock.calls[0];
    expect(blob).toBeInstanceOf(Uint8Array);

    const circles = await getAllCircles();
    expect(circles.map((c) => c.id)).toEqual(expect.arrayContaining(['circle-a', 'circle-b']));
  });

  test('preserves an existing provider field instead of overwriting the whole document', async () => {
    const seed = new Uint8Array(16).fill(5);
    await saveMasterSeed(seed);
    (getManifest as jest.Mock).mockResolvedValue(encryptJSON({ provider: 'apple' }, deriveManifestKey(seed)));
    await addCircle('circle-y');

    await syncAccountManifest();

    const [blob] = (putManifest as jest.Mock).mock.calls[0];
    const pushed = JSON.parse(new TextDecoder().decode(decrypt(blob, deriveManifestKey(seed))));
    expect(pushed.provider).toBe('apple');
    expect(pushed.circleIds).toEqual(expect.arrayContaining(['circle-y']));
  });
});

describe('syncAccountManifestBestEffort', () => {
  test('swallows a failure from the relay', async () => {
    await saveMasterSeed(new Uint8Array(16).fill(1));
    (putManifest as jest.Mock).mockRejectedValue(new Error('offline'));

    await expect(syncAccountManifestBestEffort()).resolves.toBeUndefined();
  });
});

describe('recordSignInProviderBestEffort', () => {
  test('is a no-op before a master seed exists', async () => {
    await deleteMasterSeed();

    await recordSignInProviderBestEffort('google');

    expect(putManifest).not.toHaveBeenCalled();
  });

  test('records the provider without disturbing an existing circleId list', async () => {
    const seed = new Uint8Array(16).fill(6);
    await saveMasterSeed(seed);
    (getManifest as jest.Mock).mockResolvedValue(encryptJSON({ circleIds: ['circle-z'] }, deriveManifestKey(seed)));

    await recordSignInProviderBestEffort('google');

    expect(putManifest).toHaveBeenCalledTimes(1);
    const [blob] = (putManifest as jest.Mock).mock.calls[0];
    const pushed = JSON.parse(new TextDecoder().decode(decrypt(blob, deriveManifestKey(seed))));
    expect(pushed.provider).toBe('google');
    expect(pushed.circleIds).toEqual(['circle-z']);
  });

  test('skips the write entirely when the stored provider already matches', async () => {
    const seed = new Uint8Array(16).fill(7);
    await saveMasterSeed(seed);
    (getManifest as jest.Mock).mockResolvedValue(encryptJSON({ provider: 'apple' }, deriveManifestKey(seed)));

    await recordSignInProviderBestEffort('apple');

    expect(putManifest).not.toHaveBeenCalled();
  });

  test('swallows a failure from the relay', async () => {
    await saveMasterSeed(new Uint8Array(16).fill(8));
    (putManifest as jest.Mock).mockRejectedValue(new Error('offline'));

    await expect(recordSignInProviderBestEffort('google')).resolves.toBeUndefined();
  });
});

describe('a manifest written under a different seed', () => {
  // The scenario is a real one: signing in on a new phone mints a fresh
  // seed (onboarding.ts), so the blob already on the relay is the only
  // remaining pointer to that account's circles. Overwriting it would
  // make even the correct recovery phrase useless afterwards.
  async function storeForeignManifest() {
    const theirSeed = new Uint8Array(16).fill(7);
    const blob = encryptJSON({ circleIds: ['their-circle'] }, deriveManifestKey(theirSeed));
    (getManifest as jest.Mock).mockResolvedValue(blob);
    await saveMasterSeed(new Uint8Array(16).fill(8));
  }

  test('syncAccountManifest refuses to overwrite it', async () => {
    await storeForeignManifest();
    await addCircle('mine');

    await expect(syncAccountManifest()).rejects.toThrow(ForeignManifestError);
    expect(putManifest).not.toHaveBeenCalled();
  });

  test('the best-effort variant still never writes, even though it swallows', async () => {
    await storeForeignManifest();

    await expect(syncAccountManifestBestEffort()).resolves.toBeUndefined();
    expect(putManifest).not.toHaveBeenCalled();
  });

  test('recordSignInProviderBestEffort does not clobber it either', async () => {
    await storeForeignManifest();

    await expect(recordSignInProviderBestEffort('google')).resolves.toBeUndefined();
    expect(putManifest).not.toHaveBeenCalled();
  });

  test('fetchAccountManifest reports it rather than reading it as empty', async () => {
    await storeForeignManifest();

    await expect(fetchAccountManifest()).rejects.toThrow(ForeignManifestError);
  });
});

describe('fetchAccountManifest', () => {
  test('returns an empty circleIds list before this account has ever stored a manifest', async () => {
    await saveMasterSeed(new Uint8Array(16).fill(2));
    (getManifest as jest.Mock).mockResolvedValue(null);

    await expect(fetchAccountManifest()).resolves.toEqual({ circleIds: [] });
  });

  test('decrypts what syncAccountManifest most recently pushed', async () => {
    await saveMasterSeed(new Uint8Array(16).fill(3));
    let pushed: Uint8Array | undefined;
    (putManifest as jest.Mock).mockImplementation(async (blob: Uint8Array) => {
      pushed = blob;
    });
    await addCircle('circle-x');

    await syncAccountManifest();
    (getManifest as jest.Mock).mockResolvedValue(pushed);

    const manifest = await fetchAccountManifest();
    expect(manifest.circleIds).toEqual(expect.arrayContaining(['circle-x']));
  });

  test('defaults circleIds to [] when a decrypted manifest is missing the field', async () => {
    const seed = new Uint8Array(16).fill(4);
    await saveMasterSeed(seed);
    (getManifest as jest.Mock).mockResolvedValue(encryptJSON({}, deriveManifestKey(seed)));

    await expect(fetchAccountManifest()).resolves.toEqual({ circleIds: [] });
  });

  test('throws without calling the relay when there is no master seed', async () => {
    await deleteMasterSeed();

    await expect(fetchAccountManifest()).rejects.toThrow();
    expect(getManifest).not.toHaveBeenCalled();
  });
});
