import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { PrimaryButton } from '@/components/primary-button';
import { SecondaryButton } from '@/components/secondary-button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Radius, Tints } from '@/constants/theme';
import type { PendingRequest } from '@/domain/usecases/circle/invite-to-circle';

function formatRelativeTime(ms: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / (60 * 1000)));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export type PendingJoinRequestCardProps = {
  request: PendingRequest;
  /** Disables both buttons while this specific request (or another one in the same list) is being acted on. */
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
};

/**
 * One pending join request, with its own approve/deny actions — shared
 * between `circle/details.tsx` and `circle/invite.tsx`, which both show
 * the same underlying `discoverPendingRequests` data. Only ever rendered
 * for the invite's actual creator (see that function's creator-only
 * gate) — "Tapped your link" is never anyone else's, per
 * server/DESIGN.md's "Invites" section (approval is always the specific
 * creator, never any admin).
 */
export function PendingJoinRequestCard({ request, busy, onApprove, onDeny }: PendingJoinRequestCardProps) {
  return (
    <ThemedView type="surface" style={styles.card}>
      <View style={styles.header}>
        <Avatar size={44} uri={request.pictureUri} />
        <View style={styles.text}>
          <ThemedText type="cardTitle">{request.selfReportedName || 'Someone'}</ThemedText>
          <ThemedText type="meta" themeColor="muted">
            Tapped your link · {formatRelativeTime(request.createdAt)}
          </ThemedText>
        </View>
      </View>
      <View style={styles.actions}>
        <PrimaryButton label="Let in" disabled={busy} onPress={onApprove} style={styles.actionButton} />
        <SecondaryButton label="Not now" disabled={busy} onPress={onDeny} style={styles.actionButton} />
      </View>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.panel,
    borderWidth: 1,
    borderColor: Tints.chipReactedBorder,
    padding: 16,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
  },
});
