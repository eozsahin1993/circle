import { AvatarTints } from '@/constants/theme';

/**
 * The one or two letters standing in for a member with no profile picture.
 * Empty for a name we don't have — the caller's cue to fall back to the
 * anonymous placeholder, and an ordinary state, since `member_added` can
 * land before the `profile_update` naming them.
 *
 * Code points rather than `charAt`, or a name opening with an emoji is cut
 * mid-surrogate-pair and renders as a box.
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
 * Which tint a member's initials sit on — derived, never random: a colour
 * differing between devices or across a reload would stop telling members
 * apart, which is the only reason to colour the placeholder at all.
 *
 * Pass the stablest identifier in scope, not necessarily the name: a
 * rename would otherwise recolour someone, and typing a name letter by
 * letter would flicker through colours as they type (see `Avatar`'s
 * `colorSeed` prop, which is what callers should actually be passing here).
 * Falling back to the name is a last resort for the cases with no better
 * id — a self-reported, unverified join request, say.
 */
export function avatarTintFor(seed: string | undefined | null): string {
  return AvatarTints[mix(fnv1a(seed ?? '')) % AvatarTints.length];
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    // The 32-bit FNV prime, by shifts so it stays where integer arithmetic is exact.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash;
}

/**
 * Murmur3's finalizer. Eight tints means the bucket is three bits, and
 * FNV's lowest three carry structure: the final character is multiplied by
 * the prime exactly once, so an ASCII case flip there (0x20) becomes
 * 0x3260 — zero in those three bits. Without this, two names differing only
 * in their last letter's case always share a tint.
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
