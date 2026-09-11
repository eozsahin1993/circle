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
 * Which tint a member's initials sit on — derived from their name, never
 * chosen at random.
 *
 * The point of the placeholder is telling members apart and recognising
 * the same person across screens, and a colour drawn at random would
 * differ between two devices and across a reload, which defeats exactly
 * that. The name is what every device already agrees on, so nothing has
 * to be synced to make them agree on a colour either.
 *
 * The name rather than the identity key, though the key is the more
 * stable value, because it's what the initials already come from: one
 * input for the whole placeholder means no second field to thread through
 * every view model, and your own avatar is one colour app-wide instead of
 * a different one per circle (identity keys are per-circle). The price is
 * that a rename recolours that member's history, and that two people
 * sharing a name share a colour — but they share initials too, and the
 * byline beside them is already identical.
 *
 * FNV-1a rather than a sum of char codes: summing makes anagrams collide
 * and barely separates names differing in one letter, which in a circle of
 * relatives is the common case.
 */
export function avatarTintFor(name: string | undefined | null): string {
  return AvatarTints[mix(fnv1a(name ?? '')) % AvatarTints.length];
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

/**
 * Murmur3's finalizer, because a palette of eight means the bucket is
 * chosen by three bits and FNV's lowest three carry structure. The last
 * character enters the hash and is multiplied by the prime exactly once, so
 * a difference of 0x20 there — an ASCII case flip — becomes 0x3260, whose
 * bottom three bits are zero: without this, any two names differing only in
 * their final letter's case are guaranteed the same tint.
 *
 * It doesn't measurably change the spread over ordinary distinct names,
 * which was already even. It removes a collision class, which matters more
 * for whatever this helper gets pointed at next.
 */
function mix(hash: number): number {
  let h = hash;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
