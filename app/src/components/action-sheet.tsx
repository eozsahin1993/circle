import { useEffect, useState } from 'react';
import { Animated, Dimensions, Modal, Pressable, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/components/themed-safe-area-view';

import { Avatar } from '@/components/avatar';
import { Icon, type IconGlyph } from '@/components/icon';
import { SecondaryButton } from '@/components/secondary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme, useTints } from '@/hooks/use-theme';

export type ActionSheetOption = {
  label: string;
  onPress: () => void;
  /** Shown to the left of the label — see `Icons`, which names these by what they mean. */
  icon: IconGlyph;
  /** A line under the label: what the action will actually do, or why it's offered at all. */
  description?: string;
  /** Renders the icon and label in the danger color — for a destructive action like removing someone. */
  destructive?: boolean;
};

export type ActionSheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Shown above the option rows — the row this sheet was opened from, e.g. a member's name. */
  title?: string;
  /** A second line under `title`, naming which one: a date and a circle, say. */
  subtitle?: string;
  /** Shown next to `title`, e.g. the member's avatar — omit for a plain text-only header. */
  avatarUri?: string;
  /** Who the avatar is, for its initials. Unset where it's a photograph rather than a face. */
  avatarName?: string;
  /** Squares off that image, for a sheet about a photograph rather than a person. */
  avatarRadius?: number;
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
export function ActionSheet({
  visible,
  onClose,
  title,
  subtitle,
  avatarUri,
  avatarName,
  avatarRadius,
  options,
}: ActionSheetProps) {
  const theme = useTheme();
  const tints = useTints();
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
          <ThemedSafeAreaView edges={['bottom']} style={styles.sheetInner}>
            <View style={[styles.grabber, { backgroundColor: theme.faintest }]} />

            {title ? (
              <View style={styles.header}>
                <Avatar size={44} uri={avatarUri} name={avatarName} radius={avatarRadius} />
                <View style={styles.headerTitle}>
                  <ThemedText type="cardTitle" numberOfLines={1}>
                    {title}
                  </ThemedText>
                  {subtitle ? (
                    <ThemedText type="meta" themeColor="muted" numberOfLines={1}>
                      {subtitle}
                    </ThemedText>
                  ) : null}
                </View>
              </View>
            ) : null}

            <ThemedView type="surface" style={styles.card}>
              {options.map((option, index) => (
                <Pressable
                  key={option.label}
                  style={({ pressed }) => [
                    styles.row,
                    { borderBottomColor: tints.chipIdleBorder },
                    index === options.length - 1 && styles.rowLast,
                    pressed && { backgroundColor: tints.chipIdleBg },
                  ]}
                  onPress={() => select(option.onPress)}>
                  <View
                    style={[
                      styles.rowIcon,
                      { backgroundColor: option.destructive ? tints.dangerWashBg : tints.chipIdleBg },
                    ]}>
                    <Icon
                      icon={option.icon}
                      size={18}
                      color={option.destructive ? theme.danger : theme.accentBright}
                    />
                  </View>
                  <View style={styles.rowText}>
                    <ThemedText type="postAuthor" themeColor={option.destructive ? 'danger' : 'text'}>
                      {option.label}
                    </ThemedText>
                    {option.description ? (
                      <ThemedText type="meta" themeColor="muted">
                        {option.description}
                      </ThemedText>
                    ) : null}
                  </View>
                </Pressable>
              ))}
            </ThemedView>

            <SecondaryButton label="Cancel" style={styles.cancelButton} onPress={onClose} />
          </ThemedSafeAreaView>
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
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  cancelButton: {
    alignSelf: 'stretch',
  },
});
