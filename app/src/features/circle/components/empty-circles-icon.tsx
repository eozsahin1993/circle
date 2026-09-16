import { Circle } from 'react-native-svg';

import { EmptyStateRings } from '@/ui/components/empty-state-rings';
import { useTheme } from '@/ui/theme/hooks/use-theme';

const RING_RADIUS = 54;

/** Five seats evenly spaced around the ring — the badge takes the top one, at -90°; these are the other four. */
const SEAT_ANGLES = [1, 2, 3, 4].map((k) => -90 + k * 72);

function seat(angle: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  return { x: 80 + RING_RADIUS * Math.cos(radians), y: 80 + RING_RADIUS * Math.sin(radians) };
}

/**
 * Decorative mark for the "no circles yet" state — four empty seats
 * pentagon-spaced around a ring, and a fifth at the top standing in for
 * the one action this screen offers: add the first.
 */
export function EmptyCirclesIcon({ size = 160 }: { size?: number }) {
  const theme = useTheme();
  const badge = seat(-90);

  return (
    <EmptyStateRings size={size}>
      <Circle cx={80} cy={80} r={16} stroke={theme.faint} strokeWidth={1} fill="none" opacity={0.6} />
      {SEAT_ANGLES.map((angle) => {
        const { x, y } = seat(angle);
        // Filled with the page background, not "none" — these sit right on
        // the mid ring, and a transparent seat would show that ring's
        // stroke cutting straight through it instead of stopping at it.
        return <Circle key={angle} cx={x} cy={y} r={8} stroke={theme.faint} strokeWidth={1.5} fill={theme.background} />;
      })}
      <Circle cx={badge.x} cy={badge.y} r={9} fill={theme.accent} />
    </EmptyStateRings>
  );
}
