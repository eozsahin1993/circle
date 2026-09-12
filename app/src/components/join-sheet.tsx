import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { BottomSheet } from '@/components/bottom-sheet';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { findPendingJoinRequestForInvite, previewInvite, requestToJoin } from '@/domain/usecases/circle/join-circle';
import { bytesToDataUri, parsePictureThumbnail } from '@/services/image';
import { showError } from '@/services/messages';

/**
 * The whole join flow, in one sheet over the circle list.
 *
 * One sheet, not two: asking and waiting are states of the same thing, and
 * a second sheet over the first would stack modals — which iOS handles
 * badly and which reads as leaving rather than progressing. For the same
 * reason this is a component the list renders, not a route: a route would
 * need a screen underneath it, and nothing about opening an invite should
 * replace what you were looking at.
 */
type Phase = 'checking' | 'error' | 'asking' | 'submitting' | 'waiting';

export type JoinSheetProps = {
  /** The invite code to preview, or null when nothing is being joined. */
  code: string | null;
  onClose: () => void;
  /** Called once a request has actually been made, so the list can show its pending row. */
  onRequested: () => void;
};

export function JoinSheet({ code, onClose, onRequested }: JoinSheetProps) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [circleName, setCircleName] = useState('');
  const [inviterName, setInviterName] = useState('');
  const [inviterPictureUri, setInviterPictureUri] = useState<string | undefined>();
  const [inviterPublicKey, setInviterPublicKey] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let stale = false;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase('checking');
    (async () => {
      try {
        const preview = await previewInvite(code);
        // Validated rather than trusted: it comes from whoever made the
        // invite, same as the name beside it.
        const picture = parsePictureThumbnail(preview.createdByPicture);
        const already = await findPendingJoinRequestForInvite(code);
        if (stale) return;

        setCircleName(preview.name);
        setInviterName(preview.createdByName);
        setInviterPictureUri(picture ? bytesToDataUri(picture) : undefined);
        setInviterPublicKey(preview.createdByPublicKey);
        setPhase(already ? 'waiting' : 'asking');
      } catch (err) {
        console.error('Failed to load invite preview', err);
        if (stale) return;
        setError("This invite doesn't work anymore — ask for a new one.");
        setPhase('error');
      }
    })();

    return () => {
      stale = true;
    };
  }, [code]);

  async function handleRequestToJoin() {
    if (!code) return;
    setPhase('submitting');
    try {
      await requestToJoin(code);
      setPhase('waiting');
      onRequested();
    } catch (err) {
      console.error('Failed to request to join', err);
      // Back to 'asking', not 'error': the invite is fine, the send wasn't.
      // The error state takes the button away, which would make a dropped
      // connection look like a dead key.
      setPhase('asking');
      showError('Could not send your request', { action: { label: 'Retry', onPress: handleRequestToJoin } });
    }
  }

  return (
    <BottomSheet visible={code !== null && phase !== 'checking'} onClose={onClose}>
      <View style={styles.content}>
        {phase === 'error' ? (
          <>
            <ThemedText type="cardTitle">Can&apos;t open this invite</ThemedText>
            <ThemedText type="meta" themeColor="muted">
              {error}
            </ThemedText>
            <PrimaryButton label="Close" onPress={onClose} style={styles.button} />
          </>
        ) : (
          <>
            {/* Avatar and text on one line, so the sheet stays card-height
                rather than screen-height. The circle's name carries the
                weight; who sent the key is context, not the headline. */}
            <View style={styles.header}>
              <Avatar size={48} uri={inviterPictureUri} name={inviterName} colorSeed={inviterPublicKey} />
              <View style={styles.headerText}>
                <ThemedText type="meta" themeColor="muted" numberOfLines={1}>
                  {inviterName ? `${inviterName} invited you to` : "You've been invited to"}
                </ThemedText>
                <ThemedText type="cardTitle" numberOfLines={2}>
                  {circleName}
                </ThemedText>
              </View>
            </View>

            <ThemedText type="meta" themeColor="muted">
              {phase === 'waiting'
                ? `You've asked to join — ${inviterName || 'whoever sent the key'} hasn't answered yet.`
                : `${inviterName || 'Whoever shared this key'} still has to approve you before you're in.`}
            </ThemedText>

            <PrimaryButton
              label={phase === 'waiting' ? 'Done' : phase === 'submitting' ? 'Sending request…' : 'Request to join'}
              disabled={phase === 'submitting'}
              onPress={phase === 'waiting' ? onClose : handleRequestToJoin}
              style={styles.button}
            />
          </>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: Spacing.screenPadding,
    paddingTop: 4,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  headerText: {
    flex: 1,
    gap: 2,
  },
  button: {
    marginTop: 2,
  },
});
