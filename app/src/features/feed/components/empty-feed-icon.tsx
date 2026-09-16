import Svg, { Circle, Rect } from 'react-native-svg';
import { View } from 'react-native';

import { useTheme } from '@/ui/theme/hooks/use-theme';

/** Decorative mark for a brand-new circle's empty feed — one photo card, waiting for its first. */
export function EmptyFeedIcon({ size = 160 }: { size?: number }) {
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
        <Rect x={51} y={44} width={58} height={78} rx={10} stroke={theme.faint} strokeWidth={1.5} fill="none" />
        <Circle cx={80} cy={83} r={6} fill={theme.accent} />
      </Svg>
    </View>
  );
}
