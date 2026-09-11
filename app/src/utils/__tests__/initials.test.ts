import { AvatarTints } from '@/constants/theme';
import { avatarTintFor, initialsOf } from '@/utils/initials';

describe('initialsOf', () => {
  it('takes one letter from a single name and the outer two from more', () => {
    expect(initialsOf('Ada')).toBe('A');
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    // First and last, never the middle — "AB" would be a different person's
    // monogram.
    expect(initialsOf('Ada Byron Lovelace')).toBe('AL');
  });

  it('is empty for a name nothing resolved', () => {
    // The caller's signal to draw the anonymous placeholder instead. A
    // member can arrive via member_added before their profile_update does,
    // so this is an ordinary state rather than a bug.
    expect(initialsOf(undefined)).toBe('');
    expect(initialsOf(null)).toBe('');
    expect(initialsOf('')).toBe('');
    expect(initialsOf('   ')).toBe('');
  });

  it('survives the whitespace a name field actually collects', () => {
    expect(initialsOf('  ada   lovelace  ')).toBe('AL');
    expect(initialsOf('Ada\tLovelace')).toBe('AL');
  });

  it('does not cut a multi-byte character in half', () => {
    // charAt would return a lone surrogate here and render as a box.
    expect(initialsOf('🌻 Sunflower')).toBe('🌻S');
    expect(initialsOf('𝒜da')).toBe('𝒜');
  });

  it('keeps scripts that have no uppercase as they are', () => {
    expect(initialsOf('雪 山')).toBe('雪山');
    expect(initialsOf('ольга крылова')).toBe('ОК');
  });
});

describe('avatarTintFor', () => {
  it('always lands on a tint from the palette', () => {
    for (const seed of ['', 'a', 'deadbeef', 'Ada Lovelace', '0'.repeat(64)]) {
      expect(AvatarTints).toContain(avatarTintFor(seed));
    }
    expect(AvatarTints).toContain(avatarTintFor(undefined));
  });

  it('gives one seed the same tint every time', () => {
    // The whole reason this isn't random: two devices, and the same device
    // after a reload, have to agree without being told.
    const key = 'a3f1c95e2b7d4806a3f1c95e2b7d4806';
    expect(avatarTintFor(key)).toBe(avatarTintFor(key));
  });

  it('spreads hex keys across the whole palette', () => {
    // Identity keys share an alphabet, so a weak hash piles them onto a
    // couple of tints and the colour stops distinguishing anyone. 200 keys
    // differing only in their last characters should reach every tint.
    const tints = new Set(
      Array.from({ length: 200 }, (_, i) => avatarTintFor(`a3f1c95e2b7d4806${i.toString(16).padStart(4, '0')}`))
    );
    expect(tints.size).toBe(AvatarTints.length);
  });

  it('separates keys that differ only in one character', () => {
    // Prefix-sharing is the common case for hex ids, and a hash that only
    // sums characters would put several of these together.
    const near = ['deadbeef0', 'deadbeef1', 'deadbeef2', 'deadbeef3'].map(avatarTintFor);
    expect(new Set(near).size).toBeGreaterThan(1);
  });
});
