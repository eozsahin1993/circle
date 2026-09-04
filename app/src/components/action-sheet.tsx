import { Feather } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Animated, Dimensions, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/avatar';
import { SecondaryButton } from '@/components/secondary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing, Tints } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ActionSheetOption = {
  label: string;
  onPress: () => void;
  /** Feather icon name shown to the left of the label — see feather.dev for the full set. */
  icon: keyof typeof Feather.glyphMap;
  /** Renders the icon and label in the danger color — for a destructive action like removing someone. */
  destructive?: boolean;
};

export type ActionSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Shown above the option rows — the row this sheet was opened from, e.g. a member's name. */
  title?: string;
  /** Shown next to `title`, e.g. the member's avatar — omit for a plain text-only header. */
  avatarUri?: string;
  options: ActionSheetOption[];
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SLIDE_DISTANCE = Dimensions.get('window').height;

/**
 * A generic "three dots" menu — same animated slide-up-from-bottom
 * mechanics as `PrivacyInfoModal`, generalized to a list of tappable
 * options instead of one fixed screen's content, so any row-level menu
 * (member management today, more later) can reuse it rather than
 * reaching for `Alert.alert`, which can't render more than a couple of
 * plainly-styled buttons. Options sit in their own rounded card (same
 * `Radius.panel` grouping as the account screen's device/notification
 * cards); Cancel is a separate, ordinary `SecondaryButton` below it,
 * rather than folded into the list as one more row.
 */
export function ActionSheet({ visible, onClose, title, avatarUri, options }: ActionSheetProps) {
  const theme = useTheme();
  // Same not-yet-visible-but-still-mounted trick as PrivacyInfoModal —
  // needed so the closing slide-down animation has something to animate.
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

  function select(onPress: () => void) {
    onClose();
    onPress();
  }

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <AnimatedPressable style={[styles.backdrop, { opacity: progress }]} onPress={onClose} />

      <Animated.View
        style={[
          styles.sheet,
          { transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [SLIDE_DISTANCE, 0] }) }] },
        ]}>
        <ThemedView style={styles.sheetOuter}>
          <SafeAreaView edges={['bottom']} style={styles.sheetInner}>
            <View style={styles.grabber} />

            {title ? (
              <View style={styles.header}>
                <Avatar size={36} uri={avatarUri} />
                <ThemedText type="postAuthor" numberOfLines={1} style={styles.headerTitle}>
                  {title}
                </ThemedText>
              </View>
            ) : null}

            <ThemedView type="surface" style={styles.card}>
              {options.map((option, index) => (
                <Pressable
                  key={option.label}
                  style={({ pressed }) => [
                    styles.row,
                    index === options.length - 1 && styles.rowLast,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => select(option.onPress)}>
                  <Feather name={option.icon} size={19} color={option.destructive ? theme.danger : theme.accentBright} />
                  <ThemedText type="postAuthor" themeColor={option.destructive ? 'danger' : 'text'}>
                    {option.label}
                  </ThemedText>
                </Pressable>
              ))}
            </ThemedView>

            <SecondaryButton label="Cancel" style={styles.cancelButton} onPress={onClose} />
          </SafeAreaView>
        </ThemedView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheetOuter: {
    borderTopLeftRadius: Radius.bottomSheet,
    borderTopRightRadius: Radius.bottomSheet,
    overflow: 'hidden',
  },
  sheetInner: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: 10,
    paddingBottom: Spacing.cardListGap,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.dark.faintest,
    marginBottom: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  headerTitle: {
    flex: 1,
  },
  card: {
    borderRadius: Radius.panel,
    overflow: 'hidden',
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: Spacing.screenPadding,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Tints.chipIdleBorder,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowPressed: {
    backgroundColor: Tints.chipIdleBg,
  },
  cancelButton: {
    alignSelf: 'stretch',
  },
});
