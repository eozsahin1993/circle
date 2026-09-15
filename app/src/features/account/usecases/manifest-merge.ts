import type { ManifestCircle, ManifestPayload, ManifestProfile } from '@/features/account/usecases/account-manifest';

/**
 * How one field of the manifest combines what this device knows with what's
 * already stored.
 *
 * Returning `stored` **by reference** means "I had nothing to add" — that's
 * what lets `mergeManifest` skip a pointless write, so a rule must not
 * rebuild an equal object when nothing changed.
 */
type MergeRule<T> = (stored: T | undefined, mine: T | undefined) => T | undefined;

/**
 * One rule per field. The mapped type is the point: add a field to
 * `ManifestPayload` and this stops compiling until you say how it merges,
 * so no writer gets to decide that for itself.
 */
const RULES: { [K in keyof Required<ManifestPayload>]: MergeRule<Required<ManifestPayload>[K]> } = {
  circles: mergeCircles,
  profile: newerProfileWins,
  // The only field a device can state unilaterally: it's a fact about this
  // sign-in, not shared state two devices can both be right about.
  provider: (stored, mine) => mine ?? stored,
};

/**
 * Folds this device's contribution into the stored manifest, or returns null
 * when nothing changed.
 *
 * **Contributions only.** No rule may drop something merely because this
 * device doesn't have it — absence is also what the account's other phone
 * looks like. Departures are stated as tombstones instead.
 */
export function mergeManifest(stored: ManifestPayload, mine: Partial<ManifestPayload>): ManifestPayload | null {
  const merged: ManifestPayload = { ...stored };
  let changed = false;

  for (const field of Object.keys(RULES) as (keyof ManifestPayload)[]) {
    const rule = RULES[field] as MergeRule<unknown>;
    const next = rule(stored[field], mine[field]);
    if (next === stored[field]) continue;
    // Narrowing per field would need a discriminated union the payload
    // doesn't have; the RULES type already pins each rule to its own field.
    (merged as Record<string, unknown>)[field] = next;
    changed = true;
  }

  return changed ? merged : null;
}

/**
 * Circles combine by id, and key versions within a circle, because a device
 * behind on a rotation holds an older map and one that hasn't heard of a
 * circle holds none of it. A version's key never changes, so combining can't
 * conflict.
 *
 * A departure is terminal for its id: once `leftAt` is set no later
 * contribution changes the record, which is what lets a device that hasn't
 * synced its own removal keep contributing the circle harmlessly. `leftAt`
 * is a flag, nothing else about the record changes at departure — unlike
 * the old keyless tombstone, a departure is recorded even for a circle
 * the manifest never held before: it isn't just "retiring" a prior entry
 * anymore, it's the only place account deletion can later find this
 * circle's address and keys to erase its content there.
 */
function hasLeft(circle: ManifestCircle | undefined): boolean {
  return circle?.leftAt !== undefined;
}

function mergeCircles(stored: ManifestCircle[] | undefined, mine: ManifestCircle[] | undefined) {
  if (!mine?.length) return stored;

  // Not a defaulted parameter: `stored` has to be returned by the same
  // reference it came in as when nothing changes, and `= []` would hand back
  // a fresh array that reads as a change on every single merge.
  const byId = new Map((stored ?? []).map((circle) => [circle.circleId, circle]));
  let changed = false;

  for (const circle of mine) {
    const existing = byId.get(circle.circleId);
    if (hasLeft(existing)) continue;

    const keyMap = { ...existing?.keyMap, ...circle.keyMap };
    const keyMapGrew = !existing || Object.keys(keyMap).length !== Object.keys(existing.keyMap).length;
    if (!hasLeft(circle) && !keyMapGrew) continue;

    byId.set(circle.circleId, { ...circle, keyMap });
    changed = true;
  }

  return changed ? [...byId.values()] : stored;
}

/**
 * Nothing to combine, so the newer edit wins. A stored profile with no
 * `updatedAt` predates the field, and loses — it also predates every edit
 * this device knows about.
 */
function newerProfileWins(stored: ManifestProfile | undefined, mine: ManifestProfile | undefined) {
  if (!mine) return stored;
  if (stored && stored.updatedAt >= mine.updatedAt) return stored;
  return mine;
}
