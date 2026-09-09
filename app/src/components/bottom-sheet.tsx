import { useEffect, useState, type ReactNode } from 'react';
import { Animated, Dimensions, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardAvoider } from '@/components/keyboard-avoider';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing } from '@/constants/theme';

export type BottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SLIDE_DISTANCE = Dimensions.get('window').height;

/**
 * The slide-up-from-the-bottom container every sheet in the app sits in:
 * dimmed backdrop, grabber, bottom safe-area inset, and a height capped
 * under the top inset so a tall sheet can't run under the status bar.
 *
 * Laid out with `justifyContent: 'flex-end'` inside a `KeyboardAvoider`
 * rather than pinned absolutely to the bottom. Absolute positioning gives
 * `KeyboardAvoidingView` no frame to measure against, so a sheet with a
 * text field in it would sit under the keyboard on Android.
 */
export function BottomSheet({ visible, onClose, children }: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  // Mounted but not visible, so the closing slide-down has something left
  // to animate.
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
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <AnimatedPressable style={[styles.backdrop, { opacity: progress }]} onPress={onClose} />

      <KeyboardAvoider style={styles.container}>
        <Animated.View
          style={{
            transform: [
              { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [SLIDE_DISTANCE, 0] }) },
            ],
          }}>
          <ThemedView style={[styles.sheet, { maxHeight: SLIDE_DISTANCE - insets.top }]}>
            <SafeAreaView edges={['bottom']} style={styles.inner}>
              <View style={styles.grabber} />
              {children}
            </SafeAreaView>
          </ThemedView>
        </Animated.View>
      </KeyboardAvoider>
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
  container: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Radius.bottomSheet,
    borderTopRightRadius: Radius.bottomSheet,
    overflow: 'hidden',
  },
  inner: {
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
});
