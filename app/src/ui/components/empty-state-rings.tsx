import type { ReactNode } from 'react';
import Svg, { Circle, G, Rect } from 'react-native-svg';
import { View } from 'react-native';

import { useTheme } from '@/ui/theme/hooks/use-theme';

export type EmptyStateRingsProps = {
  size?: number;
  children: ReactNode;
};

/**
 * The dashed accent ring + faint inner ring behind every "nothing here
 * yet" mark — shared by `EmptyCirclesIcon`, `EmptyFeedIcon`, and whatever
 * comes next, so the family reads as one system rather than each screen
 * inventing its own ring. Callers draw their own content as `children`,
 * in the same 160×160 viewBox the rings are sized for.
 */
export function EmptyStateRings({ size = 160, children }: EmptyStateRingsProps) {
  const theme = useTheme();

  return (
    // Wrapped so the node Fabric moves is a plain view, never the SvgView — see avatar.tsx.
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 160 160">
        <Circle
          cx={80}
          cy={80}
          r={78}
          stroke={theme.accent}
          strokeWidth={1}
          strokeDasharray="3 7"
          fill="none"
          opacity={0.55}
        />
        <Circle cx={80} cy={80} r={54} stroke={theme.faint} strokeWidth={1} fill="none" opacity={0.6} />
        {children}
      </Svg>
    </View>
  );
}

export type FannedCardProps = {
  /** Degrees around the same pivot every fanned card shares — negative leans left, positive leans right. */
  rotate: number;
  /** Extra marks on this card, in its own unrotated local space — e.g. a corner badge. */
  children?: ReactNode;
};

/**
 * One card in the fan `EmptyFeedIcon` draws — every card the same size
 * and pivot, so a fan reads as one stack rather than unrelated
 * rectangles. `children` is how one card differs from the rest:
 * `EmptyFeedIcon` hangs an add badge off the front card's corner.
 */
export function FannedCard({ rotate, children }: FannedCardProps) {
  const theme = useTheme();

  return (
    // Pivot sits below the rings' center so the cards, which extend
    // upward from it, land vertically centered rather than riding high.
    <G transform={`translate(80, 111) rotate(${rotate})`}>
      <Rect x={-23} y={-62} width={46} height={62} rx={9} stroke={theme.faint} strokeWidth={1.5} fill="none" />
      {children}
    </G>
  );
}
