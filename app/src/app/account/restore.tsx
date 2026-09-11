import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KeyboardAvoider } from '@/components/keyboard-avoider';
import { PrimaryButton } from '@/components/primary-button';
import { ScreenHeader } from '@/components/navbar/screen-header';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Spacing } from '@/constants/theme';
import { restoreFromPhrase } from '@/domain/usecases/account/restore-from-phrase';
import { useTheme } from '@/hooks/use-theme';
import { showDone } from '@/services/messages';

const WORD_COUNT = 12;

/**
 * Types a recovery phrase back in. One field rather than twelve boxes:
 * the phrase is usually pasted or read aloud, and BIP39's checksum
 * already catches a mistyped word, so per-word inputs would add friction
 * without adding a check.
 */
export default function RestoreScreen() {
  const theme = useTheme();
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const words = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;

  async function handleRestore() {
    setBusy(true);
    setError(null);
    try {
      const { circleCount } = await restoreFromPhrase(phrase);
      showDone(
        circleCount === null
          ? 'Recovered your account'
          : circleCount === 1
            ? 'Recovered your account and 1 circle'
            : `Recovered your account and ${circleCount} circles`,
      );
      router.replace('/circle');
    } catch (err) {
      console.error('Failed to restore from a recovery phrase', err);
      setError(
        err instanceof Error && err.message.includes('already in a circle')
          ? err.message
          : "Those words aren't a valid recovery phrase. Check for a typo.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <ScreenHeader title="Recovery phrase" />

        <KeyboardAvoider style={styles.body}>
          <ThemedText type="captionFeed" themeColor="secondary">
            Type the {WORD_COUNT} words from your old phone, in order, separated by spaces.
          </ThemedText>

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

          <ThemedText type="meta" themeColor={words === WORD_COUNT ? 'accentBright' : 'muted'}>
            {words} of {WORD_COUNT} words
          </ThemedText>

          {error ? (
            <ThemedText type="meta" themeColor="danger">
              {error}
            </ThemedText>
          ) : null}

          <View style={styles.spacer} />

          {/* Said plainly here rather than discovered later: the phrase
              proves who you are, it does not re-open the circles. Only a
              member can do that, by letting you back in. */}
          <ThemedText type="meta" themeColor="faint">
            This gets your identity back, so when someone lets you into a circle again you return as
            yourself, with your old posts still yours. You will still need a new invite for each one.
          </ThemedText>

          <PrimaryButton
            label="Restore"
            disabled={busy || words !== WORD_COUNT}
            onPress={handleRestore}
          />
        </KeyboardAvoider>
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
  body: {
    flex: 1,
    gap: 12,
  },
  input: {
    minHeight: 110,
    padding: 16,
    borderRadius: Radius.input,
    borderWidth: 1,
    fontSize: 16,
    textAlignVertical: 'top',
  },
  spacer: {
    flex: 1,
  },
});
