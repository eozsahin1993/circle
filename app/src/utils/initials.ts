import { AvatarTints } from '@/constants/theme';

/**
 * The one or two letters standing in for a member with no profile picture.
 *
 * Empty for a name we don't have, which is the caller's signal to fall back
 * to the anonymous placeholder rather than draw an empty coloured circle —
 * a member can arrive via `member_added` before their `profile_update` does,
 * so a blank name is an ordinary state, not a bug.
 *
 * Splits on whitespace and takes the first and last word, so "Ada Byron
 * Lovelace" is AL rather than AB. Iterated as code points, not `charAt`:
 * a name starting with an emoji or an astral-plane character would
 * otherwise be cut mid-surrogate-pair and render as a replacement box.
 *
 * First-and-last is the monogram convention, and unlike shortening a name
 * for prose (which membership-event-row.tsx refuses to do, for good
 * reason) it claims nothing about which part is the family name — "MC"
 * doesn't assert that Cruz is the surname the way printing "Maria" would
 * assert Maria is the given one. The full name always renders beside this.
 */
export function initialsOf(name: string | undefined | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  const first = firstCodePoint(words[0]);
  const last = words.length > 1 ? firstCodePoint(words[words.length - 1]) : '';
  return (first + last).toUpperCase();
}

function firstCodePoint(word: string): string {
  return Array.from(word)[0] ?? '';
}

/**
 * Which tint a member's initials sit on — derived from `seed`, never
 * chosen at random.
 *
 * The point of the placeholder is telling members apart and recognising
 * the same person across screens, and a colour drawn at random would
 * differ between two devices and across a reload, which defeats exactly
 * that. Pass the member's identity public key: it's stable forever and
 * identical everywhere, so every device agrees without anything being
 * synced to make them. Not their name: names resolve live from the roster
 * precisely so a rename updates everywhere, and a colour that moved
 * because someone fixed their spelling would be worse than no colour.
 *
 * Identity keys are per-circle, so your own avatar is a different colour
 * in each of your circles, and a screen showing only the device profile —
 * which has no key — seeds from the name instead. Deliberate: the
 * consistency worth having is looking the same to yourself as you do to
 * everyone else *within* a circle, which is the only place both are on
 * screen together.
 *
 * FNV-1a rather than a sum of char codes, because identity keys are hex
 * and share an alphabet — a weak mix puts visibly many of them on the
 * same tint.
 */
export function avatarTintFor(seed: string | undefined | null): string {
  return AvatarTints[fnv1a(seed ?? '') % AvatarTints.length];
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // Multiply by the 32-bit FNV prime, via shifts so it stays inside the
    // range where JS integer arithmetic is exact.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash;
}
