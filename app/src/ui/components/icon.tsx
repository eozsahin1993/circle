import type { IconGlyph } from '@/core/utils/icon-glyph';

export type { IconGlyph } from '@/core/utils/icon-glyph';

export type IconProps = {
  icon: IconGlyph;
  size: number;
  color: string;
  /** Solid rather than outline, for a glyph with an on state. */
  filled?: boolean;
};

/**
 * Every icon in the app goes through here, so weight is one edit rather
 * than a number repeated at forty call sites.
 */
export function Icon({ icon: Glyph, size, color, filled }: IconProps) {
  return <Glyph size={size} color={color} fill={filled ? color : 'none'} strokeWidth={STROKE_WIDTH} />;
}

/** Lucide's own default. Feather drew at the same weight, so nothing shifts. */
const STROKE_WIDTH = 2;
