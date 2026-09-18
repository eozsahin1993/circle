import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, TextInput, View } from 'react-native';
import { ThemedSafeAreaView } from '@/ui/theme/themed-safe-area-view';

import { KeyboardAvoider } from '@/ui/components/keyboard-avoider';
import { PrimaryButton } from '@/ui/components/buttons/primary-button';
import { SecondaryButton } from '@/ui/components/buttons/secondary-button';
import { ScreenHeader } from '@/ui/components/navbar/screen-header';
import { ThemedText } from '@/ui/theme/themed-text';
import { ThemedView } from '@/ui/theme/themed-view';
import { Fonts, Radius, Spacing } from '@/ui/theme/tokens';
import { NoRecoveryPhraseError, pickRecoveryCard } from '@/features/account/usecases/recovery-card';
import { PhoneInCircleError, restoreFromPhrase } from '@/features/account/usecases/restore-from-phrase';
import { useTheme } from '@/ui/theme/hooks/use-theme';
import { showDone } from '@/core/services/messages';

const WORD_COUNT = 12;

/**
 * Types a recovery phrase back in. One field rather than twelve boxes:
 * the phrase is usually pasted or read aloud, and BIP39's checksum
 * already catches a mistyped word, so per-word inputs would add friction
 * without adding a check.
 */
export default function RestoreScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  const words = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;

  async function handleRestore() {
    setBusy(true);
    setError(null);
    try {
      const { circleCount } = await restoreFromPhrase(phrase);
      showDone(
        circleCount === null
          ? t('account.restore.restored')
          : t('account.restore.restoredWithCircles', { count: circleCount }),
      );
      router.replace('/circle');
    } catch (err) {
      console.error('Failed to restore from a recovery phrase', err);
      setError(
        err instanceof PhoneInCircleError ? t('account.restore.alreadyInCircle') : t('account.restore.invalidPhrase'),
      );
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fills the field rather than restoring straight away — the words appear
   * where they were going to be typed, so a wrong file is visible before
   * it's acted on rather than after.
   */
  async function handlePickCard() {
    setPicking(true);
    setError(null);
    try {
      const picked = await pickRecoveryCard();
      if (picked) setPhrase(picked);
    } catch (err) {
      console.error('Failed to read a recovery card', err);
      setError(
        err instanceof NoRecoveryPhraseError ? t('account.restore.noPhraseInFile') : t('account.restore.unreadableFile'),
      );
    } finally {
      setPicking(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <ThemedSafeAreaView style={styles.safeArea}>
        <ScreenHeader title={t('account.restore.title')} />

        <KeyboardAvoider style={styles.body}>
          <ThemedText type="bodyMedium" themeColor="secondary">
            {t('account.restore.intro', { total: WORD_COUNT })}
          </ThemedText>

          {/* First, because it is the path that can't be got wrong. The
              field below stays for a card that was printed, read aloud, or
              never saved at all. */}
          <SecondaryButton
            label={picking ? t('account.restore.reading') : t('account.restore.chooseCard')}
            disabled={picking || busy}
            onPress={handlePickCard}
          />

          <TextInput
            value={phrase}
            onChangeText={setPhrase}
            placeholder="wolf ladder among…"
            placeholderTextColor={theme.faint}
            autoFocus
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[
              styles.input,
              { color: theme.text, borderColor: error ? theme.danger : theme.faint, backgroundColor: theme.background },
            ]}
          />

          <ThemedText type="labelSmall" themeColor={words === WORD_COUNT ? 'accentBright' : 'muted'}>
            {t('account.restore.wordCount', { typed: words, total: WORD_COUNT })}
          </ThemedText>

          {error ? (
            <ThemedText type="labelSmall" themeColor="danger">
              {error}
            </ThemedText>
          ) : null}

          <View style={styles.spacer} />

          {/* Said plainly here rather than discovered later: the phrase
              proves who you are, it does not re-open the circles. Only a
              member can do that, by letting you back in. */}
          <ThemedText type="labelSmall" themeColor="faint">
            {t('account.restore.identityNote')}
          </ThemedText>

          <PrimaryButton
            label={t('account.restore.restore')}
            disabled={busy || words !== WORD_COUNT}
            onPress={handleRestore}
          />
        </KeyboardAvoider>
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
  body: {
    flex: 1,
    gap: 12,
  },
  input: {
    minHeight: 110,
    padding: 16,
    borderRadius: Radius.input,
    borderWidth: 1,
    fontFamily: Fonts.sans,
    fontSize: 16,
    textAlignVertical: 'top',
  },
  spacer: {
    flex: 1,
  },
});
