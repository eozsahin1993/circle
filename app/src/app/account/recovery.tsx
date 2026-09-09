import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { SecondaryButton } from '@/components/secondary-button';
import { ScreenHeader } from '@/components/navbar/screen-header';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing, Tints } from '@/constants/theme';
import { getMasterSeed } from '@/services/keystore';

export default function RecoveryPhraseScreen() {
  const [words, setWords] = useState<string[] | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    getMasterSeed().then((seed) => {
      if (seed) setWords(entropyToMnemonic(seed, wordlist).split(' '));
    });
  }, []);

  /**
   * Hands the words to the OS share sheet so they can land in a mailbox
   * or notes app, which people keep and can search years later, unlike the
   * paper this screen otherwise implies. Deliberately the device's own
   * share sheet rather than anything the relay sends: a phrase the server
   * transmits is a phrase the server saw.
   */
  async function handleSendToSelf() {
    if (!words) return;
    await Share.share({
      message: `Circle recovery phrase\n\n${words.join(' ')}\n\nThese 12 words restore your circles on a new phone. Anyone who has them can too.`,
    });
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Recovery phrase" />

        <View style={styles.content}>
          <ThemedText type="captionFeed" themeColor="secondary">
            These 12 words can rebuild your circle keys on a new phone. Anyone who has them can too,
            so keep them somewhere only you can get to.
          </ThemedText>

          <ThemedView type="surface" style={styles.card}>
            {revealed && words ? (
              <View style={styles.grid}>
                {words.map((word, index) => (
                  <View key={`${index}-${word}`} style={styles.wordCell}>
                    <ThemedText type="meta" themeColor="faint" style={styles.wordIndex}>
                      {index + 1}
                    </ThemedText>
                    <ThemedText type="inviteKey" style={styles.word}>
                      {word}
                    </ThemedText>
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.hidden}>
                <ThemedText type="meta" themeColor="muted" style={styles.hiddenText}>
                  Make sure nobody can see your screen before revealing these.
                </ThemedText>
              </View>
            )}
          </ThemedView>

          <View style={styles.spacer} />

          {revealed ? <SecondaryButton label="Save them somewhere" onPress={handleSendToSelf} /> : null}

          <PrimaryButton
            label={revealed ? 'Done' : 'Reveal words'}
            disabled={!words}
            onPress={() => (revealed ? router.back() : setRevealed(true))}
          />
        </View>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    paddingHorizontal: Spacing.screenPadding,
  },
  content: {
    flex: 1,
    gap: Spacing.cardListGap,
  },
  card: {
    borderColor: Tints.chipIdleBorder,
    borderWidth: 1,
    borderRadius: Radius.panel,
    padding: Spacing.screenPadding,
    minHeight: 220,
    justifyContent: 'center',
  },
  hidden: {
    paddingVertical: Spacing.cardListGap,
  },
  hiddenText: {
    textAlign: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  wordCell: {
    width: '45%',
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  wordIndex: {
    width: 16,
  },
  word: {
    fontSize: 16,
    letterSpacing: 0,
    textTransform: 'lowercase',
  },
  spacer: {
    flex: 1,
  },
});
