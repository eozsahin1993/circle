import { Buffer } from 'buffer';

import { bytesToHex } from '@noble/curves/utils.js';

import { getProfile, listCircleAddresses, listLeftCircles, type Profile } from '@/data/db';
import { decrypt, encryptJSON } from '@/core/crypto/primitives';
import { deriveManifestKey } from '@/features/account/crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { compressToThumbnail } from '@/core/photo/image';
import { getCircleKeyMap } from '@/core/services/keystore/circle-keys';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { mergeManifest } from '@/features/account/usecases/manifest-merge';
import { getManifest, ManifestConflictError, putManifest } from '@/features/account/services/manifest-relay';

/** Everything a phrase alone has to rebuild an account from. Every field optional: there's no schema version to gate on. */
export type ManifestPayload = {
  /** Content keys are random and unreadable from the log itself, so this is the only copy a phrase can reach. */
  circles?: ManifestCircle[];
  /** Apple withholds the name on every sign-in after the first, so it can't be re-asked for. */
  profile?: ManifestProfile;
  provider?: 'google' | 'apple';
};

export type ManifestProfile = {
  name: string;
  /** The 96px thumbnail, base64 — not the 1080px original the local row keeps. */
  picture?: string;
  /** From `device_profile.updatedAt`, so the newer of two devices' edits wins. */
  updatedAt: number;
};

/**
 * Departure is tombstoned rather than deleted, so every write stays additive.
 * Absence can't mean "removed": it's also what a circle joined on the
 * account's other phone looks like, and dropping that destroys keys only
 * that phone holds. Tombstones are kept indefinitely.
 */
export type ManifestCircle = {
  /** Local id — the circle identity derives from it, so it has to come back verbatim. */
  circleId: string;
  /** The relay-facing log address, which no amount of seed material can reproduce. */
  syncId: string;
  /** Every version this member holds, `{ version: hex key }`. */
  keyMap: Record<number, string>;
  /** Set when no longer a member, whatever the reason — left, removed, or the circle deleted for everyone. Mirrors `circles.leftAt`. */
  leftAt?: number;
};

/** A circle the phrase can actually rebuild — joined, with its keys. */
export type RecoverableCircle = ManifestCircle & { leftAt?: undefined };

/**
 * Set once, by the screen where someone chose to abandon an account this
 * device can't read — see `abandonPriorAccount`. Everywhere else a foreign
 * manifest stays fatal, because overwriting it destroys the only record of
 * which circles that identity was in.
 *
 * Kept in AsyncStorage rather than in memory: the first sync that would
 * hit it can happen after a restart, and re-asking later is impossible —
 * by then there's a seed, so the question never comes up again.
 */
const FOREIGN_OVERWRITE_KEY = 'account.foreignManifestOverwriteAllowed';

export async function allowForeignManifestOverwrite(): Promise<void> {
  await AsyncStorage.setItem(FOREIGN_OVERWRITE_KEY, '1');
}

async function foreignOverwriteAllowed(): Promise<boolean> {
  return (await AsyncStorage.getItem(FOREIGN_OVERWRITE_KEY)) === '1';
}

/**
 * Raised when the relay holds a manifest this device's seed can't open.
 * That means the blob belongs to a different seed — the same account on a
 * phone whose seed this one has no way to reproduce — so it is the *only*
 * copy of that identity's circle keys. Overwriting it would destroy them
 * permanently, and no recovery phrase could bring them back afterwards, so
 * every write path treats this as fatal rather than as "no manifest yet".
 */
export class ForeignManifestError extends Error {
  constructor() {
    super("The stored manifest was written by a seed this device doesn't have.");
    this.name = 'ForeignManifestError';
  }
}

type ManifestState = { version: number } & (
  | { status: 'absent' }
  | { status: 'ours'; payload: ManifestPayload }
  | { status: 'foreign' }
);

/** Absent vs. foreign is the distinction that matters: both leave nothing readable, but only absent is safe to write over. */
async function readAccountManifest(masterSeed: Uint8Array): Promise<ManifestState> {
  const { blob, version } = await getManifest();
  if (!blob) return { status: 'absent', version };

  try {
    const key = deriveManifestKey(masterSeed);
    const payload = JSON.parse(new TextDecoder().decode(decrypt(blob, key))) as ManifestPayload;
    return { status: 'ours', payload, version };
  } catch {
    // Not ours to read, so not ours to replace.
    return { status: 'foreign', version };
  }
}

/**
 * Fetches and decrypts this account's manifest — an empty payload before
 * this account has ever stored one. Throws `ForeignManifestError` if one
 * exists under a different seed.
 */
export async function fetchAccountManifest(): Promise<ManifestPayload> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error("Can't decrypt the manifest without a master seed.");

  const state = await readAccountManifest(masterSeed);
  if (state.status === 'foreign') throw new ForeignManifestError();
  return state.status === 'ours' ? state.payload : {};
}

/**
 * One manifest operation at a time on this device, in call order. The
 * version check would catch interleaving anyway, but at the cost of a wasted
 * round trip, and this device's own writes have no reason to race.
 */
let pending: Promise<unknown> = Promise.resolve();

function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.then(work, work);
  pending = next.catch(() => undefined);
  return next;
}

/** Enough to outlast a couple of devices racing; a real livelock is a bug, not a retry budget. */
const MAX_WRITE_ATTEMPTS = 4;

/**
 * States everything this device holds and lets `mergeManifest` decide what
 * changed. The only thing that writes this document.
 *
 * Deliberately not per-circle: stating the whole picture means any write
 * also repairs earlier ones that failed, which a targeted write can't.
 * Converging on current state rather than replaying missed events is also
 * why offline needs no queue — SQLite and the Keychain are the durable
 * record, and what to push is re-derived from them.
 *
 * No-op before a seed exists.
 */
export function reconcileAccountManifest(): Promise<void> {
  return serialised(async () => {
    const masterSeed = await getMasterSeed();
    if (!masterSeed) return;

    const key = deriveManifestKey(masterSeed);
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const state = await readAccountManifest(masterSeed);
      if (state.status === 'foreign' && !(await foreignOverwriteAllowed())) throw new ForeignManifestError();

      // Already-departed ids the stored manifest holds — see
      // describeLocalState for why these are skipped rather than
      // re-described. Local state is read per attempt: leaving a circle
      // between the read and the write would otherwise be written from a
      // stale snapshot.
      const alreadyDeparted = new Set(
        (state.status === 'ours' ? state.payload.circles : [])
          ?.filter((circle) => circle.leftAt !== undefined)
          .map((circle) => circle.circleId)
      );
      const payload = mergeManifest(state.status === 'ours' ? state.payload : {}, await describeLocalState(alreadyDeparted));
      if (!payload) return;

      try {
        await putManifest(encryptJSON(payload, key), state.version);
        return;
      } catch (err) {
        // A conflict re-runs the merge against the newer payload rather than
        // re-sending this blob, which would drop what the other device wrote.
        if (!(err instanceof ManifestConflictError)) throw err;
      }
    }
    throw new Error('Another device kept changing the manifest first.');
  });
}

/**
 * Local state in the manifest's own shape. Departures come off the
 * `leftAt` rows the leaving paths set before they purge.
 *
 * `alreadyDeparted` skips the keystore lookup for a circle the stored
 * manifest already tombstones — `mergeCircles` treats that record as
 * immutable, so describing it again here would just be thrown away.
 * The lookup only ever matters once: the pass that first records a
 * circle as left, while its keys are still in the keystore (or, for one
 * this device left before ever recording it, its last chance to).
 */
async function describeLocalState(alreadyDeparted: Set<string>): Promise<Partial<ManifestPayload>> {
  const joined = await listCircleAddresses();
  const described = await Promise.all(joined.map((circle) => describeCircle(circle)));
  const left = await listLeftCircles();
  const leftDescribed = await Promise.all(
    left.map(async ({ id, syncId, leftAt }) => ({
      circleId: id,
      syncId,
      keyMap: alreadyDeparted.has(id) ? {} : ((await describeCircle({ id, syncId }))?.keyMap ?? {}),
      leftAt,
    }))
  );
  const profile = await getProfile();
  const provider = await storedSignInProvider();

  return {
    circles: [...described.filter((circle): circle is RecoverableCircle => circle !== null), ...leftDescribed],
    ...(profile ? { profile: await describeProfile(profile) } : {}),
    ...(provider ? { provider } : {}),
  };
}

/** `reconcileAccountManifest` with the swallowing every caller needs — a dead relay must never block a local join or leave. */
export async function recordInManifestBestEffort(): Promise<void> {
  try {
    await reconcileAccountManifest();
  } catch (err) {
    console.error('Failed to record local state in the account manifest', err);
  }
}

/** One circle's address and keys, or null if its keys haven't arrived yet — a circle mid-join. */
async function describeCircle(circle: { id: string; syncId: string }): Promise<RecoverableCircle | null> {
  const keyMap = await getCircleKeyMap(circle.id);
  if (!keyMap) return null;

  return {
    circleId: circle.id,
    syncId: circle.syncId,
    keyMap: Object.fromEntries(Object.entries(keyMap).map(([version, key]) => [version, bytesToHex(key)])),
  };
}

/** The 96px thumbnail rather than the 1080px original: it's what other members already see, and this document is rewritten often. */
async function describeProfile(profile: Profile): Promise<ManifestProfile> {
  const described = { name: profile.name, updatedAt: profile.updatedAt };
  if (!profile.picture) return described;
  try {
    return { ...described, picture: Buffer.from(await compressToThumbnail(profile.picture)).toString('base64') };
  } catch (err) {
    // A compression failure mustn't cost the circle keys sharing this write.
    console.error('Failed to compress profile picture for the account manifest', err);
    return described;
  }
}

/**
 * Records which provider this account most recently signed in with.
 *
 * Saved locally first so it becomes derivable, and therefore rides along on
 * every later write rather than depending on this one landing. Best-effort:
 * a dead relay mustn't block finishing sign-in over a field nothing reads
 * back.
 */
export async function recordSignInProviderBestEffort(provider: 'google' | 'apple'): Promise<void> {
  try {
    await AsyncStorage.setItem(SIGN_IN_PROVIDER_KEY, provider);
    await reconcileAccountManifest();
  } catch (err) {
    console.error('Failed to record sign-in provider', err);
  }
}

const SIGN_IN_PROVIDER_KEY = 'account.signInProvider';

async function storedSignInProvider(): Promise<'google' | 'apple' | undefined> {
  const provider = await AsyncStorage.getItem(SIGN_IN_PROVIDER_KEY);
  return provider === 'google' || provider === 'apple' ? provider : undefined;
}

/**
 * Whether this account has a manifest that this device can't read — the
 * signature of signing in somewhere new after having used Circle before.
 *
 * Only the blob's existence is knowable here, never its contents: it's
 * encrypted under the old seed, and the relay holds nothing in the clear
 * that would say how many circles it lists or what they're called. Any
 * screen built on this has to speak in those terms.
 *
 * Asked before onboarding mints a seed, which is the last moment the
 * answer can change anything — after that the old identity is
 * unreachable, and `ForeignManifestError` turns every later manifest
 * write into a failure nobody chose.
 */
export async function hasUnreadableAccountManifest(): Promise<boolean> {
  if (await getMasterSeed()) return false;
  return (await getManifest()).blob !== null;
}
