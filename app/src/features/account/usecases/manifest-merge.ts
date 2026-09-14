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
 * A departure is terminal for its id: no later contribution puts the keys
 * back, which is what lets a device that hasn't synced its own removal keep
 * contributing the circle harmlessly.
 */
function mergeCircles(stored: ManifestCircle[] | undefined, mine: ManifestCircle[] | undefined) {
  if (!mine?.length) return stored;

  // Not a defaulted parameter: `stored` has to be returned by the same
  // reference it came in as when nothing changes, and `= []` would hand back
  // a fresh array that reads as a change on every single merge.
  const byId = new Map((stored ?? []).map((circle) => [circle.circleId, circle]));
  let changed = false;

  for (const circle of mine) {
    const existing = byId.get(circle.circleId);
    if (existing?.leftAt !== undefined) continue;

    if (circle.leftAt !== undefined) {
      // Nothing recorded, so nothing to retire. Tombstoning anyway would
      // grow the document for circles that never reached it.
      if (!existing) continue;
      byId.set(circle.circleId, { circleId: circle.circleId, leftAt: circle.leftAt });
      changed = true;
      continue;
    }

    const keyMap = { ...existing?.keyMap, ...circle.keyMap };
    if (existing && Object.keys(keyMap).length === Object.keys(existing.keyMap).length) continue;
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
