import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { PrimaryButton } from '@/components/primary-button';
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

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.back}>
          <BackButton label="Recovery phrase" />
        </View>

        <View style={styles.content}>
          <ThemedText type="captionFeed" themeColor="secondary">
            These 12 words can rebuild your circle keys on a new phone. Anyone who has them can too
            — keep them as offline as the photos themselves.
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
    paddingTop: Spacing.topPadUnderStatusBar,
  },
  back: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    marginBottom: Spacing.cardListGap,
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
