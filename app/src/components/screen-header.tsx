import { StyleSheet, View } from 'react-native';

import { BackButton, type BackButtonProps } from '@/components/back-button';
import { Spacing } from '@/constants/theme';

export type ScreenHeaderProps = BackButtonProps;

/**
 * The back/close row every screen opens with — the one place its spacing
 * lives, so it can't drift screen to screen. Not used by the two screens
 * whose headers aren't "go back one screen" chrome: `circle/index.tsx`
 * (stack root) and `feed.tsx` (see `CircleHeader`).
 */
export function ScreenHeader(props: ScreenHeaderProps) {
  return (
    <View style={styles.back}>
      <BackButton {...props} />
    </View>
  );
}

const styles = StyleSheet.create({
  back: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    marginBottom: Spacing.cardListGap,
  },
});
