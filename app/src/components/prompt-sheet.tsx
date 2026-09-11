import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { BottomSheet } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { SecondaryButton } from '@/components/secondary-button';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type PromptSheetProps = {
  visible: boolean;
  title: string;
  description?: string;
  /** What the field starts with — reset each time the sheet opens. */
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
  busy?: boolean;
};

/**
 * A one-field prompt, as a sheet.
 *
 * Exists because `Alert.prompt` is iOS-only — the Android path would
 * otherwise be a silently missing text box rather than a visibly broken
 * one — and a sheet keeps a small edit in the same shape as every other
 * small action in the app.
 */
export function PromptSheet({
  visible,
  title,
  description,
  initialValue = '',
  placeholder,
  confirmLabel,
  onCancel,
  onConfirm,
  busy,
}: PromptSheetProps) {
  const theme = useTheme();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  return (
    <BottomSheet visible={visible} onClose={onCancel}>
      <View style={styles.body}>
        <ThemedText type="cardTitle">{title}</ThemedText>
        {description ? (
          <ThemedText type="meta" themeColor="muted">
            {description}
          </ThemedText>
        ) : null}

        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder={placeholder}
          placeholderTextColor={theme.faint}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => value.trim() && onConfirm(value)}
          style={[styles.input, { color: theme.text, borderColor: theme.faint, backgroundColor: theme.background }]}
        />

        <View style={styles.actions}>
          <SecondaryButton label="Cancel" style={styles.action} onPress={onCancel} />
          <PrimaryButton
            label={confirmLabel}
            style={styles.action}
            disabled={busy || !value.trim()}
            onPress={() => onConfirm(value)}
          />
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: 12,
    paddingHorizontal: Spacing.screenPadding,
  },
  input: {
    height: 48,
    paddingHorizontal: 16,
    borderRadius: Radius.input,
    borderWidth: 1,
    fontSize: 16,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  action: {
    flex: 1,
  },
});
