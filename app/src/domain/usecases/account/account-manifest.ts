import { getAllCircles } from '@/data/db';
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
 * Fetches and decrypts this account's manifest — `{ circleIds: [] }`
 * before this account has ever stored one, same shape as an empty one.
 */
export async function fetchAccountManifest(): Promise<ManifestPayload> {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error("Can't decrypt the manifest without a master seed.");

  const blob = await getManifest();
  if (!blob) return { circleIds: [] };

  const key = deriveManifestKey(masterSeed);
  const payload = JSON.parse(new TextDecoder().decode(decrypt(blob, key))) as ManifestPayload;
  // decrypt() already rules out tampering; this just covers a missing field.
  return { ...payload, circleIds: payload.circleIds ?? [] };
}

async function putAccountManifest(masterSeed: Uint8Array, payload: ManifestPayload): Promise<void> {
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

  const current = await fetchAccountManifest();
  const circles = await getAllCircles();
  await putAccountManifest(masterSeed, { ...current, circleIds: circles.map((circle) => circle.id) });
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

    const current = await fetchAccountManifest();
    if (current.provider === provider) return;

    await putAccountManifest(masterSeed, { ...current, provider });
  } catch (err) {
    console.error('Failed to record sign-in provider', err);
  }
}
