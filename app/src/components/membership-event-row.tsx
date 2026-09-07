import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

export type MembershipEventItem = {
  id: string;
  kind: 'joined' | 'removed';
  name: string;
  /** Data URI of the member's picture, when known — otherwise the hatch placeholder shows. */
  photoUri?: string;
  timestamp: string;
};

/**
 * One roster change in the feed — who joined, who is no longer here.
 * Quieter than a `PostCard` on purpose: a smaller avatar and a single
 * line, so photographs stay the only thing that carries weight in the
 * timeline. Removals are deliberately unattributed — whose decision it
 * was isn't the circle's business.
 */
export function MembershipEventRow({ event }: { event: MembershipEventItem }) {
  return (
    <View style={styles.row}>
      <Avatar size={28} uri={event.photoUri} />
      <ThemedText type="meta" themeColor="muted" style={styles.text}>
        <ThemedText type="meta">{event.name}</ThemedText>
        {event.kind === 'joined' ? ' joined' : ' is no longer in this circle'} · {event.timestamp}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: Spacing.screenPadding,
  },
  text: {
    flex: 1,
  },
});
