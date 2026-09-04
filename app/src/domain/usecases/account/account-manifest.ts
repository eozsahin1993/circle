import { listCircles } from '@/data/db';
import { decrypt, deriveManifestKey, encryptJSON } from '@/services/crypto';
import { getMasterSeed } from '@/services/keystore';
import { getManifest, putManifest } from '@/services/relay';

/**
 * What this account's manifest holds — today circleIds and provider, but
 * meant to grow (the relay only ever sees ciphertext, so a new field here
 * is the whole change). Every field optional: no schema version to gate
 * on, so an older or newer blob may just be missing one. provider is
 * recorded client-side rather than by the server on purpose — it keeps
 * this document entirely client-owned, the server never writes into it.
 */
export type ManifestPayload = {
  circleIds?: string[];
  provider?: 'google' | 'apple';
};

/**
 * Raised when the relay holds a manifest this device's seed can't open.
 * That means the blob belongs to a different seed — the same account on a
 * phone whose seed this one has no way to reproduce — so it is the *only*
 * record of which circles that account belongs to. Overwriting it would
 * destroy the pointer permanently, and no recovery phrase could bring it
 * back afterwards, so every write path treats this as fatal rather than
 * as "no manifest yet".
 */
export class ForeignManifestError extends Error {
  constructor() {
    super("The stored manifest was written by a seed this device doesn't have.");
    this.name = 'ForeignManifestError';
  }
}

type ManifestState =
  | { status: 'absent' }
  | { status: 'ours'; payload: ManifestPayload }
  | { status: 'foreign' };

/**
 * What the relay currently holds for this account, as one of three
 * states rather than a value-or-throw. The distinction that matters is
 * absent vs. foreign: both leave this device with nothing readable, but
 * only the first makes it safe to write.
 */
async function readAccountManifest(masterSeed: Uint8Array): Promise<ManifestState> {
  const blob = await getManifest();
  if (!blob) return { status: 'absent' };

  try {
    const key = deriveManifestKey(masterSeed);
    const payload = JSON.parse(new TextDecoder().decode(decrypt(blob, key))) as ManifestPayload;
    // decrypt() already rules out tampering; this just covers a missing field.
    return { status: 'ours', payload: { ...payload, circleIds: payload.circleIds ?? [] } };
  } catch {
    // AEAD authentication failed, or the plaintext wasn't our JSON — either
    // way this blob isn't ours to read, and it isn't ours to replace.
    return { status: 'foreign' };
  }
}

/**
 * Fetches and decrypts this account's manifest — `{ circleIds: [] }`
 * before this account has ever stored one, same shape as an empty one.
 * Throws `ForeignManifestError` if one exists under a different seed.
 */
export async function fetchAccountManifest(): Promise<ManifestPayload> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error("Can't decrypt the manifest without a master seed.");

  const state = await readAccountManifest(masterSeed);
  if (state.status === 'foreign') throw new ForeignManifestError();
  return state.status === 'ours' ? state.payload : { circleIds: [] };
}

/**
 * Writes the manifest. `state` is the read this payload was built from,
 * and is required rather than re-fetched so a caller cannot write without
 * having established what it is overwriting — see ForeignManifestError.
 */
async function putAccountManifest(
  masterSeed: Uint8Array,
  payload: ManifestPayload,
  state: ManifestState,
): Promise<void> {
  if (state.status === 'foreign') throw new ForeignManifestError();

  const key = deriveManifestKey(masterSeed);
  await putManifest(encryptJSON(payload, key));
}

/**
 * Pushes this account's current circleId list to the relay, encrypted
 * under a key derived from the master seed — see server/DESIGN.md's
 * "Account recovery" section. Call after anything that changes local
 * membership (create, leave, delete). No-op before onboarding generates
 * a seed. Merges onto whatever's already stored (e.g. `provider`) rather
 * than overwriting the whole document, so this can't clobber a field it
 * doesn't know about.
 */
export async function syncAccountManifest(): Promise<void> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) return;

  const state = await readAccountManifest(masterSeed);
  if (state.status === 'foreign') throw new ForeignManifestError();

  const current = state.status === 'ours' ? state.payload : { circleIds: [] };
  // listCircles, not getAllCircles: this runs on create/join/leave and
  // only needs ids, so there's no reason to drag cover blobs through it.
  const circles = await listCircles();
  await putAccountManifest(masterSeed, { ...current, circleIds: circles.map((circle) => circle.id) }, state);
}

/**
 * Same as `syncAccountManifest`, but swallows failures — offline or
 * relay-down shouldn't block creating/leaving/deleting a circle locally,
 * same reasoning as signOut()'s best-effort server revoke.
 */
export async function syncAccountManifestBestEffort(): Promise<void> {
  try {
    await syncAccountManifest();
  } catch (err) {
    console.error('Failed to sync account manifest', err);
  }
}

/**
 * Records which provider this account most recently signed in with —
 * call right after a successful sign-in. Best-effort and self-contained
 * (unlike syncAccountManifest, nothing else needs a non-swallowing
 * variant): offline or relay-down shouldn't block finishing sign-in over
 * a purely informational field. Skips the write entirely if the stored
 * value already matches, so a normal repeat sign-in doesn't touch the
 * network at all.
 */
export async function recordSignInProviderBestEffort(provider: 'google' | 'apple'): Promise<void> {
  try {
    const masterSeed = await getMasterSeed();
    if (!masterSeed) return;

    const state = await readAccountManifest(masterSeed);
    if (state.status === 'foreign') throw new ForeignManifestError();

    const current = state.status === 'ours' ? state.payload : { circleIds: [] };
    if (current.provider === provider) return;

    await putAccountManifest(masterSeed, { ...current, provider }, state);
  } catch (err) {
    console.error('Failed to record sign-in provider', err);
  }
}
