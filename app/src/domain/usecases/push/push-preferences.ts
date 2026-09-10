import { getAppSettings } from '@/services/settings';
import { getAllCircles, getCircle, setCirclePushCategoryMask, setCirclePushSilenced } from '@/data/db';
import { silenceCircle, syncCirclePushPrefs, PushCategories, type PushCategory } from '@/domain/usecases/push/push-registration';

/**
 * Which notifications this account wants, and for which circles.
 *
 * Categories are an account-wide setting (`services/settings.ts`), but the
 * relay stores them per circle, so a change to one has to be pushed to
 * every circle's row. Silencing is per circle and enforced by removing
 * that row outright — iOS shows a card for any delivered alert push, so
 * the only way to show nothing is to not be delivered to.
 */

/**
 * How much a circle is allowed to interrupt you, as a ladder rather than
 * independent switches: each level is the one below plus one more kind.
 * Nobody wants reactions but not posts, and four toggles asked a question
 * this list answers in one tap.
 *
 * Order is quietest-first. The stored value is still a mask, so an unusual
 * combination arriving from another device survives being read back.
 */
export const PushLevels = [
  { id: 'posts', label: 'New photos only', categories: [PushCategories.newPost] },
  {
    id: 'comments',
    label: 'Photos and comments',
    categories: [PushCategories.newPost, PushCategories.comment],
  },
  {
    id: 'reactions',
    label: 'Photos, comments and reactions',
    categories: [PushCategories.newPost, PushCategories.comment, PushCategories.reaction],
  },
] as const;

/**
 * Someone joining is in every level, not a rung on the ladder. It is a
 * security event rather than a social one — a new member can see every
 * photo already in the circle — and only the invite's creator approves,
 * against a name and picture the requester chose. Telling everyone else is
 * how a family member gets to say "wait, who is that?". It also happens a
 * handful of times per circle ever, so it costs nothing in volume.
 *
 * Silencing the circle still covers it. Nothing else turns it off.
 */
const ALWAYS: readonly PushCategory[] = [PushCategories.memberJoined];

export type PushLevelId = (typeof PushLevels)[number]['id'];

/** The mask a newly created or joined circle starts with. */
export async function defaultCircleMask(): Promise<number> {
  return maskForLevel((await getAppSettings()).defaultPushLevel as PushLevelId);
}

export function maskForLevel(id: PushLevelId): number {
  const level = PushLevels.find((candidate) => candidate.id === id) ?? PushLevels[PushLevels.length - 1];
  return [...level.categories, ...ALWAYS].reduce<number>((mask, category) => mask | (1 << category), 0);
}

/**
 * The closest level to a stored mask. Exact where the mask was written by
 * one of these; otherwise the nearest below, so an unrecognised combination
 * shows as quieter than it is rather than louder.
 */
export function levelForMask(mask: number): PushLevelId {
  let best: PushLevelId = PushLevels[0].id;
  for (const level of PushLevels) {
    // Subset, not `<=`: masks aren't ordered as numbers, so posts plus
    // member-joins (0b1001) would otherwise read as the reactions level
    // purely because 7 is less than 9.
    const levelMask = maskForLevel(level.id);
    if ((mask & levelMask) === levelMask) best = level.id;
  }
  return best;
}

/** Unpacks a stored mask into the list the relay's wire format takes. */
export function categoriesFromMask(mask: number): PushCategory[] {
  return Object.values(PushCategories).filter((category) => mask & (1 << category));
}

export type CirclePushPreferences = { silenced: boolean; level: PushLevelId; categories: PushCategory[] };

/** What the circle's notification section renders. */
export async function circlePushPreferences(circleId: string): Promise<CirclePushPreferences> {
  const circle = await getCircle(circleId);
  const mask = circle?.pushCategoryMask ?? 0;
  return { silenced: circle?.pushSilenced ?? false, level: levelForMask(mask), categories: categoriesFromMask(mask) };
}

/** Changes how much one circle may interrupt. Written locally first, since that is what the row reads. */
export async function setCircleLevel(circleId: string, level: PushLevelId): Promise<void> {
  const mask = maskForLevel(level);
  await setCirclePushCategoryMask(circleId, mask);
  await syncCirclePushPrefs(circleId, categoriesFromMask(mask));
}

/**
 * Silences or unsilences one circle. The local flag is written first and
 * is what the UI reads: the relay has no read endpoint, so a failed
 * network call must not leave the toggle showing the wrong thing.
 */
export async function setCircleSilenced(circleId: string, silenced: boolean): Promise<void> {
  await setCirclePushSilenced(circleId, silenced);

  if (silenced) {
    await silenceCircle(circleId);
    return;
  }
  await syncCirclePushPrefs(circleId, categoriesFromMask((await getCircle(circleId))?.pushCategoryMask ?? 0));
}

/**
 * Re-pushes every circle's own mask to the relay — after a key rotation,
 * which invalidates the fanout hash, or on launch.
 *
 * Best-effort per circle: one being offline or missing a content key
 * shouldn't stop the rest.
 */
export async function syncPushPreferences(): Promise<void> {
  for (const circle of await getAllCircles()) {
    if (circle.pushSilenced) continue;
    try {
      await syncCirclePushPrefs(circle.id, categoriesFromMask(circle.pushCategoryMask));
    } catch (err) {
      console.error(`Failed to sync push preferences for circle ${circle.id}`, err);
    }
  }
}
