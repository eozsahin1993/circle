import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { BackButton, type BackButtonProps } from '@/components/back-button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

export type ScreenHeaderProps = BackButtonProps & {
  /** What this screen is — "Post", "Album". Omit for a bare arrow. */
  title?: string;
  /** Which one, when the title alone is ambiguous: the circle an album belongs to, say. */
  subtitle?: string;
  /** Icon controls pinned right, about the screen as a whole — `HeaderIconButton`s. */
  actions?: ReactNode;
};

/**
 * The back/close row every screen opens with — the one place its spacing
 * lives, so it can't drift screen to screen. Not used by the two screens
 * whose headers aren't "go back one screen" chrome: `circle/index.tsx`
 * (stack root) and `circle/feed.tsx` (see `CircleHeader`).
 *
 * Both lines sit outside the button: they name where you are, and tapping
 * where you are shouldn't take you somewhere else.
 */
export function ScreenHeader({ title, subtitle, actions, ...button }: ScreenHeaderProps) {
  return (
    <View style={styles.header}>
      <BackButton {...button} />
      {/* Always present, always flexible: it's what holds the actions
          against the right edge, with or without a title in it. */}
      <View style={styles.titles}>
        {title ? (
          <ThemedText type="cardTitle" numberOfLines={1}>
            {title}
          </ThemedText>
        ) : null}
        {subtitle ? (
          <ThemedText type="meta" themeColor="muted" numberOfLines={1}>
            {subtitle}
          </ThemedText>
        ) : null}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    // iOS's standard navigation bar, and comfortably above the 44pt
    // minimum tap target. A subtitle still fits inside it — `minHeight`
    // only so a longer type ramp can't clip.
    minHeight: 44,
    // Both gaps live here rather than on each screen, so every inner
    // screen sits at the same height and none can drift.
    marginTop: Spacing.topPadUnderSafeArea,
    marginBottom: Spacing.cardListGap,
  },
  titles: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
});
