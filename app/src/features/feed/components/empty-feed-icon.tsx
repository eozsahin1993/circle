import { Circle } from 'react-native-svg';

import { EmptyStateRings, FannedCard } from '@/ui/components/empty-state-rings';
import { useTheme } from '@/ui/theme/hooks/use-theme';

/**
 * Decorative mark for a brand-new circle's empty feed — two fanned photo
 * cards with an accent clasp dot on the front card's corner: posts stack
 * the way members do, but this stack is waiting on its first.
 */
export function EmptyFeedIcon({ size = 160 }: { size?: number }) {
  const theme = useTheme();

  return (
    <EmptyStateRings size={size}>
      <FannedCard rotate={-13} />
      <FannedCard rotate={13}>
        <Circle cx={17} cy={-8} r={6} fill={theme.accent} />
      </FannedCard>
    </EmptyStateRings>
  );
}
