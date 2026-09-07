import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icons, Radius, Tints } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type EmojiPickerProps = {
  onSelect: (emoji: string) => void;
  /**
   * Dismisses without reacting. Not optional in practice: the panel opens
   * inline over a card whose caption and photo both navigate away, so
   * "tap outside to close" would take you to the post instead. The only
   * other way out is the chip that opened it, which nothing signposts.
   */
  onClose?: () => void;
};

/**
 * The whole vocabulary — there is no free-form slot. A fixed set keeps
 * counts meaningful (a hundred near-identical faces would each stand
 * alone) and keeps the feed's tone bounded, which an open emoji keyboard
 * cannot. Order is deliberate: warmth first, then celebration, then the
 * quieter ones.
 *
 * Only the picker is limited. Nothing rejects an emoji outside this set
 * arriving over the log — a future build may add one, and dropping those
 * reactions would lose real history from a newer peer.
 */
const QUICK_REACTIONS = ['❤️', '🥂', '😂', '😭', '👏', '🙏', '✨', '🧿'];

/**
 * One full-width panel of evenly-divided slots, rather than a row of
 * separate pills — pills read as a scatter of unrelated buttons that
 * happened to land near each other, when this is a single choice among a
 * fixed set. Every slot is the same width and shares one outline, so the
 * row scans in one pass and the tap targets are unambiguous.
 *
 * One row, always. Wrapping to a grid made the panel taller than the
 * caption above it, and a choice this small shouldn't need two lines.
 */
export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const theme = useTheme();

  return (
    <View style={styles.panel}>
      {QUICK_REACTIONS.map((emoji) => (
        <Pressable key={emoji} style={styles.slot} onPress={() => onSelect(emoji)}>
          <Text style={styles.emoji}>{emoji}</Text>
        </Pressable>
      ))}

      {onClose ? (
        <Pressable style={styles.slot} onPress={onClose} accessibilityLabel="Close">
          <Feather name={Icons.close} size={17} color={theme.faint} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.panel,
    borderWidth: 1,
    borderColor: Tints.chipIdleBorder,
    backgroundColor: Tints.chipIdleBg,
    paddingHorizontal: 4,
  },
  /**
   * `flex: 1` on every slot is what divides the panel evenly however many
   * reactions the set holds — nothing here is sized to the current eight.
   * Adding many more would squeeze the slots under a comfortable tap
   * target, which is the point at which this needs to become a sheet
   * rather than an inline row.
   */
  slot: {
    flex: 1,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 20,
  },
});
