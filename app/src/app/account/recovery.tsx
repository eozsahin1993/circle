import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/core/theme/themed-safe-area-view';

import { PrimaryButton } from '@/core/components/primary-button';
import { SecondaryButton } from '@/core/components/secondary-button';
import { ScreenHeader } from '@/core/components/navbar/screen-header';
import { ThemedText } from '@/core/theme/themed-text';
import { ThemedView } from '@/core/theme/themed-view';
import { Radius, Spacing } from '@/core/theme/tokens';
import { useTints } from '@/core/theme/use-theme';
import { saveRecoveryCard } from '@/features/account/usecases/recovery-card';
import { getMasterSeed } from '@/core/services/keystore';
import { showDone, showError } from '@/core/services/messages';

export default function RecoveryPhraseScreen() {
  const tints = useTints();
  const [words, setWords] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getMasterSeed().then((seed) => {
      if (seed) setWords(entropyToMnemonic(seed, wordlist).split(' '));
    });
  }, []);

  /**
   * Writes the card and hands it to the share sheet. Steer toward iCloud
   * Drive over "On My iPhone" in the copy below — the second one sits
   * right there in the same list and dies with the phone.
   */
  async function handleSaveCard() {
    setSaving(true);
    try {
      if (await saveRecoveryCard()) showDone('Save it somewhere that survives this phone');
      else showError("This device can't share files");
    } catch (err) {
      console.error('Failed to save the recovery card', err);
      showError('Could not make your recovery card');
    } finally {
      setSaving(false);
    }
  }

  /**
   * The words as plain text — lands in a mailbox or notes app, which
   * people keep and can search years later. Recoverable only by
   * copy-paste, which is why the card sits above it.
   */
  async function handleSendToSelf() {
    if (!words) return;
    await Share.share({
      message: `Circle recovery phrase\n\n${words.join(' ')}\n\nThese 12 words restore your circles on a new phone. Anyone who has them can too.`,
    });
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Recovery phrase" />

        <View style={styles.content}>
          <ThemedText type="captionFeed" themeColor="secondary">
            These 12 words can rebuild your circle keys on a new phone. Anyone who has them can too,
            so keep them somewhere only you can get to.
          </ThemedText>

          <ThemedView type="surface" style={[styles.card, { borderColor: tints.chipIdleBorder }]}>
            {words ? (
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
            ) : null}
          </ThemedView>

          <View style={styles.spacer} />

          {/* The card first: it's the one that comes back without anyone
              retyping anything. Sharing the words as text still has a place
              — a mailbox is searchable years later — but it can only be
              recovered by copy-paste. */}
          <SecondaryButton label={saving ? 'Preparing…' : 'Save recovery card'} disabled={saving} onPress={handleSaveCard} />

          <SecondaryButton label="Send the words as text" onPress={handleSendToSelf} />

          <PrimaryButton label="Done" disabled={!words} onPress={() => router.back()} />
        </View>
      </ThemedSafeAreaView>
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
