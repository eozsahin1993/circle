import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { BackButton } from '@/components/back-button';
import { ThemedText } from '@/components/themed-text';
import { Icons, Radius, Tints } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type CircleHeaderProps = {
  name: string;
  memberCount: number;
  /** Opens the circle's Details sheet — members, invite, settings. */
  onPressDetails?: () => void;
  /** Opens the circle's album — every photo it holds, not just what's in view. */
  onPressAlbum?: () => void;
};

export function CircleHeader({ name, memberCount, onPressDetails, onPressAlbum }: CircleHeaderProps) {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      <View style={styles.back}>
        <BackButton />
      </View>

      <Pressable style={styles.titles} onPress={onPressDetails}>
        <ThemedText type="screenTitle">{name}</ThemedText>
        <ThemedText type="meta" themeColor="muted">
          {memberCount} people. Tap for details
        </ThemedText>
      </Pressable>

      <Pressable style={styles.circleButton} onPress={onPressAlbum} hitSlop={8}>
        <Feather name={Icons.album} size={18} color={theme.secondary} />
      </Pressable>

      <Pressable style={styles.circleButton} onPress={onPressDetails} hitSlop={8}>
        <Feather name={Icons.more} size={18} color={theme.secondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  back: {
    alignSelf: 'flex-start',
    paddingTop: 6,
  },
  titles: {
    flex: 1,
    gap: 4,
  },
  circleButton: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Tints.secondaryButtonBorder,
  },
});
