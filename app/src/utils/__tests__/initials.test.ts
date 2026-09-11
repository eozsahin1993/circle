import { AvatarTints } from '@/constants/theme';
import { avatarTintFor, initialsOf } from '@/utils/initials';

describe('initialsOf', () => {
  it('takes one letter from a single name and the outer two from more', () => {
    expect(initialsOf('Ada')).toBe('A');
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    // First and last, never the middle.
    expect(initialsOf('Ada Byron Lovelace')).toBe('AL');
  });

  it('is empty for a name nothing resolved', () => {
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
    for (const name of ['', 'A', 'Ada Lovelace', '雪 山', 'x'.repeat(200)]) {
      expect(AvatarTints).toContain(avatarTintFor(name));
    }
    expect(AvatarTints).toContain(avatarTintFor(undefined));
  });

  it('gives one name the same tint every time', () => {
    // Two devices, and the same device after a reload, agree without being told.
    expect(avatarTintFor('Ada Lovelace')).toBe(avatarTintFor('Ada Lovelace'));
  });

  it('spreads a realistic set of names across the whole palette', () => {
    const tints = new Set(
      Array.from({ length: 200 }, (_, i) => avatarTintFor(`Member ${i}`))
    );
    expect(tints.size).toBe(AvatarTints.length);
  });

  it('separates names differing in one letter', () => {
    // The common case in a circle of relatives.
    const near = ['Ali', 'Alo', 'Ala', 'Alu'].map(avatarTintFor);
    expect(new Set(near).size).toBeGreaterThan(1);
  });

  it('does not put every case-flipped final letter on one tint', () => {
    // The collision class `mix` removes — raw FNV-1a put all four pairs on
    // one tint. "Not all of them" rather than "none", because with eight
    // tints a single pair collides one time in eight whatever the hash does.
    const flipped = [
      ['Ada', 'AdA'],
      ['Ali', 'AlI'],
      ['Emre', 'EmrE'],
      ['Olga', 'OlgA'],
    ];
    const differing = flipped.filter(([one, other]) => avatarTintFor(one) !== avatarTintFor(other));
    expect(differing.length).toBeGreaterThan(0);
  });
});
