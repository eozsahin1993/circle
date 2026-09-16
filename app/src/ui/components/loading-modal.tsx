import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Modal, StyleSheet } from 'react-native';

import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Radius, Spacing } from '@/ui/theme/tokens';
import { useTheme } from '@/ui/theme/hooks/use-theme';

export type LoadingModalProps = {
  visible: boolean;
  label: string;
  /** A second, muted line under `label` — what to expect, or not to do, while this is up. */
  sublabel?: string;
};

/**
 * A dimmed backdrop with a centered spinner card, for work that blocks the
 * screen but isn't cancellable — same `Modal transparent` fade mechanics as
 * `ActionSheet`/`BottomSheet`, minus the slide and the backdrop's `onPress`:
 * there's nothing here to dismiss back to.
 */
export function LoadingModal({ visible, label, sublabel }: LoadingModalProps) {
  const theme = useTheme();
  // Same not-yet-visible-but-still-mounted trick as ActionSheet/BottomSheet
  // — needed so the closing fade has something left to animate.
  const [mounted, setMounted] = useState(visible);
  const [progress] = useState(() => new Animated.Value(visible ? 1 : 0));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (visible) setMounted(true);

    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 240 : 200,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, progress]);

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={() => {}}>
      <Animated.View style={[styles.backdrop, { opacity: progress }]}>
        <ThemedView type="surface" style={styles.card}>
          <ActivityIndicator size="large" color={theme.accent} />
          <ThemedText type="postAuthor" style={styles.label}>
            {label}
          </ThemedText>
          {sublabel ? (
            <ThemedText type="meta" themeColor="muted" style={styles.label}>
              {sublabel}
            </ThemedText>
          ) : null}
        </ThemedView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.screenPadding,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  card: {
    borderRadius: Radius.panel,
    paddingVertical: 28,
    paddingHorizontal: 28,
    alignItems: 'center',
    gap: 10,
    minWidth: 220,
  },
  label: {
    textAlign: 'center',
  },
});
