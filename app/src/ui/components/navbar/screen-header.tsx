import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { BackButton, type BackButtonProps } from '@/ui/components/navbar/back-button';
import { ThemedText } from '@/ui/theme/themed-text';
import { Spacing } from '@/ui/theme/tokens';

export type ScreenHeaderProps = BackButtonProps & {
  /** What this screen is — "Post", "Album". Omit for a bare arrow. */
  title?: string;
  /** Which one, when the title alone is ambiguous: the circle an album belongs to, say. */
  subtitle?: string;
  /**
   * Makes the two lines a tap target. Only for a title that names
   * something with more behind it — otherwise tapping where you already
   * are shouldn't take you anywhere.
   */
  onPressTitle?: () => void;
  /** Icon controls pinned right, about the screen as a whole — `HeaderIconButton`s. */
  actions?: ReactNode;
  /**
   * For screens with nowhere sane to go back to — onboarding right after
   * sign-in, where back would land on the sign-in screen it just left.
   */
  hideBack?: boolean;
};

/**
 * The header row every screen opens with — the one place its height,
 * type and spacing live, so it can't drift screen to screen. Used by the
 * feed as well, whose back button leaves the circle rather than the
 * screen; only `circle/index.tsx`, the stack root, has none.
 *
 * The title always names the screen it sits on, never where back goes —
 * that rule is what keeps the arrow readable, so don't pass a
 * destination or a bare context name (a circle name belongs in
 * `subtitle`). Both lines sit outside the back button, so returning and
 * opening what you're looking at stay separate targets.
 */
export function ScreenHeader({ title, subtitle, onPressTitle, actions, hideBack, ...button }: ScreenHeaderProps) {
  return (
    <View style={styles.header}>
      {hideBack ? null : <BackButton {...button} />}
      {/* Always present, always flexible: it's what holds the actions
          against the right edge, with or without a title in it. */}
      <Pressable style={styles.titles} onPress={onPressTitle} disabled={!onPressTitle}>
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
      </Pressable>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
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
