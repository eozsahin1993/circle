import { useCallback, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';

import type { FeedRow, FeedRows } from '@/components/feed/rows';
import { PendingJoinRequestCard } from '@/components/pending-join-request-card';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import {
  approveJoinRequest,
  denyJoinRequest,
  discoverPendingRequests,
  type PendingRequest,
} from '@/domain/usecases/circle/invite-to-circle';

type RequestRowActions = {
  /** Any approve/deny in flight — disables all of them, not just the one tapped. */
  busy: boolean;
  onApprove: (requesterId: string) => void;
  onDeny: (requesterId: string) => void;
};

/**
 * Join requests own their own everything: the list, the in-flight flag,
 * and the two actions. Nothing about them appears in `RowSource` or in
 * the feed's controller — they're the clearest case for a row kind being
 * a self-contained unit rather than three entries in a shared bag.
 *
 * The only kind so far with a `reload`: it owns state the feed's own read
 * doesn't cover. Separate from the feed's own because this reads the
 * mailbox, not the local database: content already on disk shouldn't wait
 * behind a network round trip. Resolves non-empty only for this invite's
 * actual creator (see `discoverPendingRequests`'s creator-only gate) —
 * silently nothing for anyone else.
 */
export type PendingRequestRowsInput = {
  circleId: string;
  /**
   * Approving admits a member, which changes the roster — and the feed's
   * snapshot of it was taken before that. `approveJoinRequest` writes
   * SQLite correctly, so this only exists to tell the holder of that
   * snapshot to re-read; without it the member count in the header stays
   * behind until the screen is left and returned to.
   */
  onRosterChanged: () => void;
};

export function usePendingRequestRows({ circleId, onRosterChanged }: PendingRequestRowsInput): FeedRows {
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!circleId) return;
    discoverPendingRequests(circleId)
      .then(setRequests)
      .catch(() => setRequests([]));
  }, [circleId]);

  const answer = useCallback(
    async (requesterId: string, act: () => Promise<void>, failure: string, changedRoster = false) => {
      setBusyId(requesterId);
      try {
        await act();
        setRequests((current) => current.filter((request) => request.requesterId !== requesterId));
        if (changedRoster) onRosterChanged();
      } catch (err) {
        console.error(failure, err);
      } finally {
        setBusyId(null);
      }
    },
    [onRosterChanged],
  );

  const actions = useMemo<RequestRowActions>(
    () => ({
      busy: busyId !== null,
      onApprove: (requesterId) =>
        answer(requesterId, () => approveJoinRequest(circleId, requesterId), 'Failed to approve join request', true),
      // Denying changes nothing outside this list.
      onDeny: (requesterId) =>
        answer(requesterId, () => denyJoinRequest(circleId, requesterId), 'Failed to dismiss join request'),
    }),
    [busyId, answer, circleId],
  );

  return useMemo(
    () => ({ rows: requests.map((request) => pendingRequestRow(request, actions)), reload }),
    [requests, actions, reload],
  );
}

export function pendingRequestRow(request: PendingRequest, actions: RequestRowActions): FeedRow {
  return {
    key: `request:${request.requesterId}`,
    spacing: Spacing.cardListGap,
    // Someone is waiting on an answer only this device can give — it
    // shouldn't scroll away behind photographs.
    sticky: true,
    render: () => (
      <ThemedView style={styles.row}>
        <PendingJoinRequestCard
          request={request}
          busy={actions.busy}
          onApprove={() => actions.onApprove(request.requesterId)}
          onDeny={() => actions.onDeny(request.requesterId)}
        />
      </ThemedView>
    ),
  };
}

const styles = StyleSheet.create({
  row: {
    marginHorizontal: Spacing.cardListGap,
  },
});
