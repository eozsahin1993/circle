import Svg, { Circle, Rect } from 'react-native-svg';
import { View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

/** Decorative mark for the "no circles yet" state — two fanned cards inside a loose ring. */
export function EmptyCirclesIcon({ size = 160 }: { size?: number }) {
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
        <Rect
          x={-23}
          y={-62}
          width={46}
          height={62}
          rx={9}
          stroke={theme.faint}
          strokeWidth={1.5}
          fill="none"
          transform="translate(80, 84) rotate(-13)"
        />
        <Rect
          x={-23}
          y={-62}
          width={46}
          height={62}
          rx={9}
          stroke={theme.faint}
          strokeWidth={1.5}
          fill="none"
          transform="translate(80, 84) rotate(13)"
        />
        <Circle cx={80} cy={84} r={6} fill={theme.accent} />
      </Svg>
    </View>
  );
}
