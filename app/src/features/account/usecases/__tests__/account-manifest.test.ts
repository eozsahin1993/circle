jest.mock('@/features/account/services/manifest-relay');
jest.mock('@/core/photo/image');

import AsyncStorage from '@react-native-async-storage/async-storage';
import { bytesToHex } from '@noble/curves/utils.js';

import { initDatabase, insertCircle, markCircleLeft, saveProfile } from '@/data/db';
import { decrypt, encryptJSON } from '@/core/crypto/primitives';
import { deriveManifestKey } from '@/features/account/crypto';
import {
  allowForeignManifestOverwrite,
  fetchAccountManifest,
  ForeignManifestError,
  hasUnreadableAccountManifest,
  recordSignInProviderBestEffort,
  recordInManifestBestEffort,
  reconcileAccountManifest,
  type RecoverableCircle,
  type ManifestPayload,
} from '@/features/account/usecases/account-manifest';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import { getManifest, ManifestConflictError, putManifest } from '@/features/account/services/manifest-relay';
import { addCircleKeyVersion, saveCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { deleteMasterSeed, saveMasterSeed } from '@/core/services/keystore/master-seed';

beforeAll(() => initDatabase());
// resetAllMocks, not clearAllMocks — a mockResolvedValue left over from a
// previous test (e.g. getManifest returning a blob encrypted under a
// different test's seed) would otherwise leak in and fail to decrypt,
// masking what each test actually means to exercise.
beforeEach(async () => {
  jest.resetAllMocks();
  // resetAllMocks strips the implementations off the shipped AsyncStorage
  // mock, so writes would silently no-op and never read back. Restored here
  // rather than weakening the reset, which the rest of the file relies on.
  const stored = new Map<string, string>();
  (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key: string, value: string) => {
    stored.set(key, value);
  });
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => stored.get(key) ?? null);

  (getManifest as jest.Mock).mockResolvedValue({ blob: null, version: 0 });
  // Circles and their key maps both persist across tests otherwise, and
  // what this file asserts is the exact set that gets pushed.
  await resetLocalDataForTesting();
});

const CONTENT_KEY = new Uint8Array(32).fill(3);

/** A circle plus the key map the manifest exists to carry — one without the other is never written. */
async function addCircle(id: string) {
  await insertCircle({ id, name: id, picture: null, syncId: `sync-${id}`, createdAt: Date.now(), leftAt: null, metaCursor: 0, contentCursor: 0, lastViewedAt: 0 });
  await saveCircleKeyMap(id, { 1: CONTENT_KEY });
}

function stored(payload: ManifestPayload, seed: Uint8Array, version = 1) {
  return { blob: encryptJSON(payload, deriveManifestKey(seed)), version };
}

/** The live entries of a pushed payload — narrows away tombstones, which carry no keys. */
function recoverable(payload: ManifestPayload) {
  return (payload.circles ?? []).filter(
    (circle): circle is RecoverableCircle => circle.leftAt === undefined,
  );
}

function pushedPayload(call = 0): ManifestPayload {
  const [blob] = (putManifest as jest.Mock).mock.calls[call];
  return JSON.parse(new TextDecoder().decode(decrypt(blob, deriveManifestKey(SEED))));
}

const SEED = new Uint8Array(16).fill(1);

describe('reconcileAccountManifest', () => {
  test('is a no-op before a master seed exists', async () => {
    await deleteMasterSeed();
    await addCircle('mine');

    await reconcileAccountManifest();

    expect(putManifest).not.toHaveBeenCalled();
  });

  /**
   * The keys are the whole reason this document exists: they're random,
   * derived from nothing, and unreadable from the log itself, so a phrase
   * can reach them here or nowhere.
   */
  test('records the circle with its log address and content keys', async () => {
    await saveMasterSeed(SEED);
    await addCircle('circle-a');

    await reconcileAccountManifest();

    expect(putManifest).toHaveBeenCalledTimes(1);
    expect(pushedPayload().circles).toEqual([
      { circleId: 'circle-a', syncId: 'sync-circle-a', keyMap: { 1: bytesToHex(CONTENT_KEY) } },
    ]);
  });

  /** A circle mid-join, whose entry lands on the write that follows its keys arriving. */
  test('writes nothing for a circle whose keys have not arrived', async () => {
    await saveMasterSeed(SEED);
    await insertCircle({ id: 'keyless', name: 'keyless', picture: null, syncId: 'sync-keyless', createdAt: 0, leftAt: null, metaCursor: 0, contentCursor: 0, lastViewedAt: 0 });

    await reconcileAccountManifest();

    expect(putManifest).not.toHaveBeenCalled();
  });

  test('preserves fields it does not own instead of replacing the document', async () => {
    await saveMasterSeed(SEED);
    (getManifest as jest.Mock).mockResolvedValue(stored({ provider: 'apple' }, SEED));
    await addCircle('circle-y');

    await reconcileAccountManifest();

    expect(pushedPayload().provider).toBe('apple');
  });

  test('quotes back the version it read, so a concurrent write is caught', async () => {
    await saveMasterSeed(SEED);
    await addCircle('mine');
    (getManifest as jest.Mock).mockResolvedValue(stored({}, SEED, 4));

    await reconcileAccountManifest();

    expect((putManifest as jest.Mock).mock.calls[0][1]).toBe(4);
  });

  /**
   * The reason a conflict re-runs the change rather than re-sending the
   * blob: the payload carries content keys, so blindly retrying would drop
   * the circle the other device just recorded and cost access to it.
   */
  test('rebuilds against fresh state when another device writes first', async () => {
    await saveMasterSeed(SEED);
    await addCircle('mine');
    (getManifest as jest.Mock)
      .mockResolvedValueOnce(stored({}, SEED, 1))
      .mockResolvedValueOnce(stored({ provider: 'google' }, SEED, 2));
    (putManifest as jest.Mock).mockRejectedValueOnce(new ManifestConflictError()).mockResolvedValueOnce(undefined);

    await reconcileAccountManifest();

    expect(putManifest).toHaveBeenCalledTimes(2);
    // The retry carries what the winning write had added, not just our own.
    expect(pushedPayload(1).provider).toBe('google');
    expect(pushedPayload(1).circles).toHaveLength(1);
  });

  /**
   * A circle joined on this account's other device is nowhere in this
   * device's local state, and nothing will ever teach it — so anything that
   * rewrote the whole list would delete it, and the other device would then
   * delete this one's, forever.
   */
  test('leaves circles it was not asked about alone', async () => {
    await saveMasterSeed(SEED);
    await addCircle('mine');
    const theirs = { circleId: 'theirs', syncId: 'sync-theirs', keyMap: { 1: bytesToHex(CONTENT_KEY) } };
    (getManifest as jest.Mock).mockResolvedValue(stored({ circles: [theirs] }, SEED));

    await reconcileAccountManifest();

    expect(pushedPayload().circles).toEqual(
      expect.arrayContaining([theirs, expect.objectContaining({ circleId: 'mine' })]),
    );
  });

  /**
   * Devices sync rotations at different times. The one still on the old key
   * must not be able to push the newer version back out of the manifest —
   * everything written under it would stop being recoverable.
   */
  test('keeps key versions this device has not synced the rotation for yet', async () => {
    await saveMasterSeed(SEED);
    await addCircle('shared'); // this device holds version 1 only
    const ahead = {
      circleId: 'shared',
      syncId: 'sync-shared',
      keyMap: { 1: bytesToHex(CONTENT_KEY), 2: bytesToHex(new Uint8Array(32).fill(9)) },
    };
    (getManifest as jest.Mock).mockResolvedValue(stored({ circles: [ahead] }, SEED));

    await reconcileAccountManifest();

    // Nothing to contribute, so nothing is sent — the newer version stands
    // rather than being overwritten by this device's shorter map.
    expect(putManifest).not.toHaveBeenCalled();
  });

  test('gives up rather than spinning when conflicts never stop', async () => {
    await saveMasterSeed(SEED);
    await addCircle('mine');
    (putManifest as jest.Mock).mockRejectedValue(new ManifestConflictError());

    await expect(reconcileAccountManifest()).rejects.toThrow('kept changing');
  });
});

describe('a departure for a circle the manifest never held', () => {
  // Still worth recording: unlike a bare tombstone, this carries the
  // address and keys account deletion needs later — it isn't "retiring"
  // a prior entry, it's the only record of this circle at all.
  test('is recorded with its address and keys', async () => {
    await saveMasterSeed(SEED);
    await addCircle('never-recorded');
    await markCircleLeft('never-recorded');
    (getManifest as jest.Mock).mockResolvedValue(stored({ circles: [] }, SEED));

    await reconcileAccountManifest();

    expect(pushedPayload().circles).toEqual([
      { circleId: 'never-recorded', syncId: 'sync-never-recorded', keyMap: { 1: bytesToHex(CONTENT_KEY) }, leftAt: expect.any(Number) },
    ]);
  });
});

describe('the profile in the manifest', () => {
  // `profile_update` entries rebuild circleMembers on replay, never the
  // local device_profile row, so two devices can hold different names
  // indefinitely without either learning — hence comparing timestamps.
  test('leaves a newer stored profile alone', async () => {
    await saveMasterSeed(SEED);
    await saveProfile({ name: 'Old', picture: null, createdAt: 1, updatedAt: 100 });
    const newer = { name: 'Renamed elsewhere', updatedAt: 200 };
    (getManifest as jest.Mock).mockResolvedValue(stored({ profile: newer }, SEED));

    await reconcileAccountManifest();

    expect(putManifest).not.toHaveBeenCalled();
  });

  test('replaces a stored profile this device has since edited', async () => {
    await saveMasterSeed(SEED);
    await saveProfile({ name: 'Renamed here', picture: null, createdAt: 1, updatedAt: 300 });
    (getManifest as jest.Mock).mockResolvedValue(stored({ profile: { name: 'Old', updatedAt: 200 } }, SEED));

    await reconcileAccountManifest();

    expect(pushedPayload().profile).toEqual({ name: 'Renamed here', updatedAt: 300 });
  });
});

describe('a departure', () => {
  // Recorded rather than deleted, so it's a contribution like any other and
  // the order two devices write in can't produce a wrong answer.
  test('tombstones the circle and leaves the rest alone', async () => {
    await saveMasterSeed(SEED);
    await addCircle('left');
    await markCircleLeft('left');
    const kept = { circleId: 'kept', syncId: 'sync-kept', keyMap: { 1: bytesToHex(CONTENT_KEY) } };
    (getManifest as jest.Mock).mockResolvedValue(
      stored({ circles: [kept, { circleId: 'left', syncId: 'sync-left', keyMap: { 1: bytesToHex(CONTENT_KEY) } }] }, SEED),
    );

    await reconcileAccountManifest();

    expect(pushedPayload().circles).toEqual([
      kept,
      { circleId: 'left', syncId: 'sync-left', keyMap: { 1: bytesToHex(CONTENT_KEY) }, leftAt: expect.any(Number) },
    ]);
  });

  /** Terminal: the other phone can keep contributing the circle and still lose. */
  test('is not undone by a device still contributing the circle', async () => {
    await saveMasterSeed(SEED);
    await addCircle('left');
    (getManifest as jest.Mock).mockResolvedValue(
      stored({ circles: [{ circleId: 'left', syncId: 'sync-left', keyMap: {}, leftAt: 123 }] }, SEED),
    );

    await reconcileAccountManifest();

    expect(putManifest).not.toHaveBeenCalled();
  });
});

/**
 * The scenarios two devices on one account actually produce. Each is a way
 * the manifest could silently lose a key, which costs access to a circle
 * rather than just being stale.
 */
describe('two devices on one account', () => {
  /**
   * The cost of stating the whole local picture rather than one circle: a
   * device that hasn't yet synced its own removal still believes it's a
   * member, still holds the keys, and so re-adds the entry.
   *
   * Transient by construction — applying that `member_removed` calls
   * the departure, which tombstones it. Benign while it lasts:
   * the rotation on removal means nothing new is readable through those
   * keys, and this device had them already.
   */
  test('re-adds a circle it has not yet learned it was removed from, until it syncs', async () => {
    await saveMasterSeed(SEED);
    await addCircle('removed-elsewhere'); // the removal hasn't reached this device
    (getManifest as jest.Mock).mockResolvedValue(stored({ circles: [] }, SEED));

    await reconcileAccountManifest();

    expect(pushedPayload().circles?.map((circle) => circle.circleId)).toEqual(['removed-elsewhere']);
  });

  /** Once the departure *is* known locally, the sweep tombstones it again. */
  test('tombstones it again once the departure is recorded locally', async () => {
    await saveMasterSeed(SEED);
    await addCircle('removed-elsewhere');
    await markCircleLeft('removed-elsewhere');
    (getManifest as jest.Mock).mockResolvedValue(
      stored({ circles: [{ circleId: 'removed-elsewhere', syncId: 'sync-removed-elsewhere', keyMap: { 1: bytesToHex(CONTENT_KEY) } }] }, SEED),
    );

    await reconcileAccountManifest();

    expect(pushedPayload().circles).toEqual([
      { circleId: 'removed-elsewhere', syncId: 'sync-removed-elsewhere', keyMap: { 1: bytesToHex(CONTENT_KEY) }, leftAt: expect.any(Number) },
    ]);
  });

  /**
   * Both devices are in the circle and a rotation lands. Whichever records
   * second must not push the other's version back out — content written
   * under a dropped key stops being recoverable.
   */
  test('a rotation recorded on either device leaves the other version intact', async () => {
    await saveMasterSeed(SEED);
    await addCircle('shared');
    await addCircleKeyVersion('shared', 2, new Uint8Array(32).fill(2));
    const theirs = {
      circleId: 'shared',
      syncId: 'sync-shared',
      keyMap: { 1: bytesToHex(CONTENT_KEY), 3: bytesToHex(new Uint8Array(32).fill(3)) },
    };
    (getManifest as jest.Mock).mockResolvedValue(stored({ circles: [theirs] }, SEED));

    await reconcileAccountManifest();

    expect(Object.keys(recoverable(pushedPayload())[0].keyMap).sort()).toEqual(['1', '2', '3']);
  });

  /** Recording a circle must never touch a profile edit made on the other device. */
  test('recording a circle leaves the other device’s newer profile alone', async () => {
    await saveMasterSeed(SEED);
    await saveProfile({ name: 'Stale here', picture: null, createdAt: 1, updatedAt: 100 });
    await addCircle('mine');
    const newer = { name: 'Renamed elsewhere', updatedAt: 999 };
    (getManifest as jest.Mock).mockResolvedValue(stored({ profile: newer }, SEED));

    await reconcileAccountManifest();

    expect(pushedPayload().profile).toEqual(newer);
  });
});

/**
 * The repair path. Every other operation fires on its own event and retries
 * only when that same event recurs, so without this a write lost to a dead
 * relay is never repaired — and that circle quietly stops being recoverable.
 */
describe('reconcileAccountManifest', () => {
  test('records a circle whose earlier write never landed', async () => {
    await saveMasterSeed(SEED);
    await addCircle('never-pushed');

    await reconcileAccountManifest();

    expect(pushedPayload().circles?.map((circle) => circle.circleId)).toEqual(['never-pushed']);
  });

  /** Being several rotations behind costs no more than one: the local map already holds them all. */
  test('catches up every key version at once, not one rotation at a time', async () => {
    await saveMasterSeed(SEED);
    await addCircle('shared');
    await addCircleKeyVersion('shared', 2, new Uint8Array(32).fill(2));
    await addCircleKeyVersion('shared', 3, new Uint8Array(32).fill(3));
    (getManifest as jest.Mock).mockResolvedValue(
      stored({ circles: [{ circleId: 'shared', syncId: 'sync-shared', keyMap: { 1: bytesToHex(CONTENT_KEY) } }] }, SEED),
    );

    await reconcileAccountManifest();

    expect(Object.keys(recoverable(pushedPayload())[0].keyMap).sort()).toEqual(['1', '2', '3']);
  });

  /** The one subtraction, and it keys off an explicit departure rather than absence. */
  test('drops a circle this device has left', async () => {
    await saveMasterSeed(SEED);
    await addCircle('gone');
    await markCircleLeft('gone');
    (getManifest as jest.Mock).mockResolvedValue(
      stored({ circles: [{ circleId: 'gone', syncId: 'sync-gone', keyMap: { 1: bytesToHex(CONTENT_KEY) } }] }, SEED),
    );

    await reconcileAccountManifest();

    expect(pushedPayload().circles).toEqual([{ circleId: 'gone', syncId: 'sync-gone', keyMap: { 1: bytesToHex(CONTENT_KEY) }, leftAt: expect.any(Number) }]);
  });

  /**
   * The failure this pass must never cause. A circle absent locally belongs
   * to this account's other phone, which holds keys this one has never seen
   * — dropping it would destroy them.
   */
  test('never drops a circle merely because this device has no row for it', async () => {
    await saveMasterSeed(SEED);
    const theirs = { circleId: 'theirs', syncId: 'sync-theirs', keyMap: { 1: bytesToHex(CONTENT_KEY) } };
    (getManifest as jest.Mock).mockResolvedValue(stored({ circles: [theirs] }, SEED));

    await reconcileAccountManifest();

    expect(putManifest).not.toHaveBeenCalled();
  });

  test('writes nothing when the manifest is already in step', async () => {
    await saveMasterSeed(SEED);
    await addCircle('in-step');
    (getManifest as jest.Mock).mockResolvedValue(
      stored({ circles: [{ circleId: 'in-step', syncId: 'sync-in-step', keyMap: { 1: bytesToHex(CONTENT_KEY) } }] }, SEED),
    );

    await reconcileAccountManifest();

    expect(putManifest).not.toHaveBeenCalled();
  });
});

/**
 * Leaving a circle while a reconciliation is in flight is an ordinary thing
 * to do, and the two must not interleave — the sweep would otherwise write
 * from a snapshot taken before the departure.
 */
describe('ordering between two manifest writes', () => {
  test('runs one at a time, in call order', async () => {
    await saveMasterSeed(SEED);
    await addCircle('leaving');
    const order: string[] = [];
    (getManifest as jest.Mock).mockImplementation(async () => {
      order.push('read');
      return { blob: null, version: 0 };
    });
    (putManifest as jest.Mock).mockImplementation(async () => {
      order.push('write');
    });

    await Promise.all([reconcileAccountManifest(), recordSignInProviderBestEffort('google')]);

    // Never read/read/write/write — each operation sees the other's result.
    expect(order).toEqual(['read', 'write', 'read', 'write']);
  });

  /** A departure recorded mid-flight still wins, because the tombstone is terminal. */
  test('a departure recorded while a sweep is running still wins', async () => {
    await saveMasterSeed(SEED);
    await addCircle('leaving');
    let latest: ManifestPayload = {};
    (getManifest as jest.Mock).mockImplementation(async () => stored(latest, SEED));
    (putManifest as jest.Mock).mockImplementation(async (blob: Uint8Array) => {
      latest = JSON.parse(new TextDecoder().decode(decrypt(blob, deriveManifestKey(SEED))));
    });

    await reconcileAccountManifest();
    await markCircleLeft('leaving');
    await reconcileAccountManifest();

    expect(latest.circles).toEqual([{ circleId: 'leaving', syncId: 'sync-leaving', keyMap: { 1: bytesToHex(CONTENT_KEY) }, leftAt: expect.any(Number) }]);
  });
});

/**
 * Leaving and being invited back. `requestToJoin` mints a fresh `circleId`
 * per join, so the rejoin is a different entry and the tombstone never
 * touches it.
 */
describe('leaving a circle and rejoining it', () => {
  test('records the rejoin under its new id, alongside the old tombstone', async () => {
    await saveMasterSeed(SEED);
    await addCircle('before');
    await markCircleLeft('before');
    await addCircle('after'); // the rejoin: same circle, new local id
    (getManifest as jest.Mock).mockResolvedValue(
      stored({ circles: [{ circleId: 'before', syncId: 'sync-before', keyMap: { 1: bytesToHex(CONTENT_KEY) } }] }, SEED),
    );

    await reconcileAccountManifest();

    expect(pushedPayload().circles).toEqual([
      { circleId: 'before', syncId: 'sync-before', keyMap: { 1: bytesToHex(CONTENT_KEY) }, leftAt: expect.any(Number) },
      { circleId: 'after', syncId: 'sync-after', keyMap: { 1: bytesToHex(CONTENT_KEY) } },
    ]);
  });

  /**
   * The trap this depends on not springing. A tombstone is terminal by id,
   * so if rejoining ever reused the old `circleId` — which is what restoring
   * the same per-circle identity would mean — the circle would be
   * permanently unrecordable. Rejoin has to keep minting a fresh one, or
   * this rule has to learn about it.
   */
  test('a reused id stays suppressed by its tombstone', async () => {
    await saveMasterSeed(SEED);
    await addCircle('reused');
    (getManifest as jest.Mock).mockResolvedValue(
      stored({ circles: [{ circleId: 'reused', syncId: 'sync-reused', keyMap: {}, leftAt: 123 }] }, SEED),
    );

    await reconcileAccountManifest();

    expect(putManifest).not.toHaveBeenCalled();
  });
});

describe('the best-effort variants', () => {
  test('swallow a failure from the relay', async () => {
    await saveMasterSeed(SEED);
    await addCircle('mine');
    (putManifest as jest.Mock).mockRejectedValue(new Error('offline'));

    await expect(recordInManifestBestEffort()).resolves.toBeUndefined();
  });
});

describe('recordSignInProviderBestEffort', () => {
  test('is a no-op before a master seed exists', async () => {
    await deleteMasterSeed();

    await recordSignInProviderBestEffort('google');

    expect(putManifest).not.toHaveBeenCalled();
  });

  test('records the provider without disturbing the circles', async () => {
    await saveMasterSeed(SEED);
    const circles = [{ circleId: 'circle-z', syncId: 'sync-z', keyMap: { 1: bytesToHex(CONTENT_KEY) } }];
    (getManifest as jest.Mock).mockResolvedValue(stored({ circles }, SEED));

    await recordSignInProviderBestEffort('google');

    expect(putManifest).toHaveBeenCalledTimes(1);
    expect(pushedPayload()).toMatchObject({ provider: 'google', circles });
  });

  test('skips the write entirely when the stored provider already matches', async () => {
    await saveMasterSeed(SEED);
    (getManifest as jest.Mock).mockResolvedValue(stored({ provider: 'apple' }, SEED));

    await recordSignInProviderBestEffort('apple');

    expect(putManifest).not.toHaveBeenCalled();
  });

  test('swallows a failure from the relay', async () => {
    await saveMasterSeed(SEED);
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
    (getManifest as jest.Mock).mockResolvedValue(stored({ circles: [] }, theirSeed));
    await saveMasterSeed(new Uint8Array(16).fill(8));
  }

  test('reconcileAccountManifest refuses to overwrite it', async () => {
    await storeForeignManifest();
    await addCircle('mine');

    await expect(reconcileAccountManifest()).rejects.toThrow(ForeignManifestError);
    expect(putManifest).not.toHaveBeenCalled();
  });

  test('the best-effort variant still never writes, even though it swallows', async () => {
    await storeForeignManifest();
    await addCircle('mine');

    await expect(recordInManifestBestEffort()).resolves.toBeUndefined();
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
  test('returns an empty payload before this account has ever stored one', async () => {
    await saveMasterSeed(SEED);

    await expect(fetchAccountManifest()).resolves.toEqual({});
  });

  test('decrypts what was most recently pushed', async () => {
    await saveMasterSeed(SEED);
    let pushed: Uint8Array | undefined;
    (putManifest as jest.Mock).mockImplementation(async (blob: Uint8Array) => {
      pushed = blob;
    });
    await addCircle('circle-x');

    await reconcileAccountManifest();
    (getManifest as jest.Mock).mockResolvedValue({ blob: pushed, version: 1 });

    const manifest = await fetchAccountManifest();
    expect(manifest.circles?.map((circle) => circle.circleId)).toEqual(['circle-x']);
  });

  /**
   * A manifest written before this feature holds an id list and no keys.
   * It has to read as "nothing to recover" rather than throwing — those
   * accounts come good once a device that still holds the keys syncs again.
   */
  test('reads a manifest written before circles carried keys as nothing to restore', async () => {
    await saveMasterSeed(SEED);
    (getManifest as jest.Mock).mockResolvedValue(
      stored({ circleIds: ['old-a'] } as ManifestPayload, SEED),
    );

    expect((await fetchAccountManifest()).circles).toBeUndefined();
  });

  test('throws without calling the relay when there is no master seed', async () => {
    await deleteMasterSeed();

    await expect(fetchAccountManifest()).rejects.toThrow();
    expect(getManifest).not.toHaveBeenCalled();
  });
});

describe('hasUnreadableAccountManifest', () => {
  test('true when this device has no seed and the account already has a manifest', async () => {
    await deleteMasterSeed();
    (getManifest as jest.Mock).mockResolvedValue({ blob: new Uint8Array([1, 2, 3]), version: 1 });

    await expect(hasUnreadableAccountManifest()).resolves.toBe(true);
  });

  test('false on a genuinely new account', async () => {
    await deleteMasterSeed();

    await expect(hasUnreadableAccountManifest()).resolves.toBe(false);
  });

  // A device with a seed can read its own manifest, or is entitled to write
  // the first one — either way there is nothing to ask about, and asking
  // would put a returning user through the recovery fork on every re-auth.
  test('false once this device has a seed, manifest or not', async () => {
    await saveMasterSeed(new Uint8Array(16).fill(3));
    (getManifest as jest.Mock).mockResolvedValue({ blob: new Uint8Array([1, 2, 3]), version: 1 });

    await expect(hasUnreadableAccountManifest()).resolves.toBe(false);
  });
});

describe('abandoning an account this device cannot read', () => {
  // What the confirmation screen exists to authorize: the one path allowed
  // to destroy the old identity's record of which circles it was in.
  test('permits an overwrite that is otherwise fatal', async () => {
    const theirSeed = new Uint8Array(16).fill(7);
    (getManifest as jest.Mock).mockResolvedValue(stored({ circles: [] }, theirSeed));
    await saveMasterSeed(new Uint8Array(16).fill(9));
    await addCircle('mine-after-fresh-start');

    await expect(reconcileAccountManifest()).rejects.toThrow(ForeignManifestError);

    await allowForeignManifestOverwrite();
    await reconcileAccountManifest();

    expect(putManifest).toHaveBeenCalledTimes(1);
  });
});
