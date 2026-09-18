import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, StyleSheet, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Radius, Spacing } from '@/ui/theme/tokens';
import { useTints } from '@/ui/theme/hooks/use-theme';
import { saveRecoveryCard } from '@/features/account/usecases/recovery-card';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { showDone, showError } from '@/core/services/messages';

export default function RecoveryPhraseScreen() {
  const { t } = useTranslation();
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
      if (await saveRecoveryCard()) showDone(t('account.recovery.cardSaved'));
      else showError(t('account.recovery.cannotShare'));
    } catch (err) {
      console.error('Failed to save the recovery card', err);
      showError(t('account.recovery.cardFailed'));
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
      message: t('account.recovery.shareMessage', { words: words.join(' ') }),
    });
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('account.recovery.title')} />

        <View style={styles.content}>
          <ThemedText type="bodyMedium" themeColor="secondary">
            {t('account.recovery.intro')}
          </ThemedText>

          <ThemedView type="surface" style={[styles.card, { borderColor: tints.chipIdleBorder }]}>
            {words ? (
              <View style={styles.grid}>
                {words.map((word, index) => (
                  <View key={`${index}-${word}`} style={styles.wordCell}>
                    <ThemedText type="labelSmall" themeColor="faint" style={styles.wordIndex}>
                      {index + 1}
                    </ThemedText>
                    <ThemedText type="code" style={styles.word}>
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
          <SecondaryButton label={saving ? t('account.recovery.preparing') : t('account.recovery.saveCard')} disabled={saving} onPress={handleSaveCard} />

          <SecondaryButton label={t('account.recovery.sendAsText')} onPress={handleSendToSelf} />

          <PrimaryButton label={t('account.recovery.done')} disabled={!words} onPress={() => router.back()} />
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
