import { useEffect, useState } from 'react';
import { Animated, Dimensions, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SecondaryButton } from '@/components/secondary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Radius, Spacing } from '@/constants/theme';

export type PrivacyInfoModalProps = {
  visible: boolean;
  onClose: () => void;
};

// This describes the intended end-to-end design, not everything that's
// actually running today — see the conversation this was added in.
// Notably: post content isn't encrypted before storage yet, there's no
// relay yet, and leaving a circle doesn't currently rotate the shared
// secret. Revisit this copy as those land for real.
const SECTIONS = [
  {
    label: 'On your phone',
    body: 'The photo is encrypted before it leaves your device. The key belongs to the circle, not to us.',
  },
  {
    label: 'In transit',
    body: 'Relays pass along sealed bytes. They can see that something moved, never what it was.',
  },
  {
    label: 'At rest',
    body: 'Copies live on the phones of everyone in the circle. Delete the app from every device and the archive is gone — so we help you keep an offline copy too.',
  },
  {
    label: 'If someone leaves',
    body: 'The circle key rotates. They keep what they already downloaded, and receive nothing new.',
  },
];

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SLIDE_DISTANCE = Dimensions.get('window').height;

export function PrivacyInfoModal({ visible, onClose }: PrivacyInfoModalProps) {
  // Modal unmounts the instant `visible` goes false, which would cut off
  // any exit animation — so mounting is tracked separately, and only
  // dropped once the closing animation actually finishes.
  const [mounted, setMounted] = useState(visible);
  const [progress] = useState(() => new Animated.Value(visible ? 1 : 0));

  useEffect(() => {
    // Opening must show the modal immediately, before the animation even
    // starts — closing can't do the equivalent (`setMounted(false)`) here,
    // it has to wait for the animation's own completion callback below, so
    // the two directions aren't symmetric enough for the render-phase
    // "adjust state from a prop" pattern to cleanly cover both.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (visible) setMounted(true);

    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 280 : 220,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, progress]);

  if (!mounted) return null;

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <AnimatedPressable style={[styles.backdrop, { opacity: progress }]} onPress={onClose} />

      <Animated.View
        style={[
          styles.sheet,
          {
            transform: [
              { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [SLIDE_DISTANCE, 0] }) },
            ],
          },
        ]}>
        <ThemedView type="surface" style={styles.sheetInner}>
          <SafeAreaView edges={['bottom']}>
            <View style={styles.grabber} />

            <ScrollView contentContainerStyle={styles.content}>
              <ThemedText type="screenTitle" style={styles.title}>
                Where your photos live
              </ThemedText>

              {SECTIONS.map((section) => (
                <View key={section.label} style={styles.section}>
                  <ThemedText type="eyebrow" themeColor="accent">
                    {section.label}
                  </ThemedText>
                  <ThemedText type="captionFeed" themeColor="secondary">
                    {section.body}
                  </ThemedText>
                </View>
              ))}
            </ScrollView>

            <View style={styles.footer}>
              <SecondaryButton label="Close" onPress={onClose} />
            </View>
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
    maxHeight: '85%',
  },
  sheetInner: {
    borderTopLeftRadius: Radius.bottomSheet,
    borderTopRightRadius: Radius.bottomSheet,
    overflow: 'hidden',
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.dark.faintest,
    marginTop: 10,
    marginBottom: 8,
  },
  content: {
    paddingHorizontal: Spacing.screenPadding,
    gap: Spacing.cardListGap,
  },
  title: {
    marginBottom: 4,
  },
  section: {
    gap: 6,
  },
  footer: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: Spacing.cardListGap,
    paddingBottom: Spacing.cardListGap,
  },
});
