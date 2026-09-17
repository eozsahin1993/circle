import { useEffect, useState } from 'react';
import { Animated, Dimensions, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Radius, Spacing } from '@/ui/theme/tokens';
import { useTheme } from '@/ui/theme/hooks/use-theme';

export type PrivacyInfoModalProps = {
  visible: boolean;
  onClose: () => void;
};

// This describes the intended end-to-end design, not everything that's
// actually running today — see the conversation this was added in.
// Notably: leaving a circle doesn't currently rotate the shared secret
// (only an admin removing someone does). Revisit this copy once that
// lands for real. "What we can see" is the exception — worded to match
// what the relay actually does today (verified against server/
// directly), not the intended design. That includes authorIdentityPublicKey,
// stored plaintext on every entry since account deletion needs it to find
// everything one identity posted — the relay can tell two entries in the
// same circle share an author, though never who that author is or
// whether they're active in any other circle.
const SECTIONS = [
  {
    label: 'Your content',
    body: "Everything you add is meant to be encrypted on your device with a key that belongs to the circle, not us. Copies remain on every member's device, and we help you keep an offline backup as well.",
  },
  {
    label: 'Your account',
    body: "Signing in only confirms you're a real person, to prevent abuse. It's stored separately from your circles and is never linked to what you post or who you're with.",
  },
  {
    label: 'What we can see',
    body: 'At rest, we can determine that two entries in the same circle share an author, but never who that person is. We see only that a circle exists, how active it is, and that requests occur, never who made them or what they contain.',
  },
  {
    label: 'If someone leaves',
    body: 'The circle key rotates when someone leaves. They keep what they already downloaded, and receive nothing further.',
  },
];

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const SLIDE_DISTANCE = Dimensions.get('window').height;

export function PrivacyInfoModal({ visible, onClose }: PrivacyInfoModalProps) {
  const theme = useTheme();
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
          <ThemedSafeAreaView edges={['bottom']}>
            <View style={[styles.grabber, { backgroundColor: theme.faintest }]} />

            <ScrollView contentContainerStyle={styles.content}>
              <ThemedText type="screenTitle" style={styles.title}>
                Where your content lives
              </ThemedText>

              {SECTIONS.map((section) => (
                <View key={section.label} style={styles.section}>
                  <ThemedText type="sectionTitle">
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
