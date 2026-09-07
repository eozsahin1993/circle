import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type MembershipEventItem = {
  id: string;
  kind: 'created' | 'added' | 'removed' | 'role_changed';
  subjectName: string;
  /** Null when this device never saw the actor join — the line renders unattributed rather than guessing. */
  actorName: string | null;
  /** The subject acted on themselves: founding the circle, or leaving it. */
  selfInflicted: boolean;
  /** Whether each side is the person reading the feed — those get "you" rather than their own name. */
  subjectIsYou: boolean;
  actorIsYou: boolean;
  /** The role landed on, for `role_changed`. Null for the other kinds. */
  role: 'admin' | 'member' | null;
  timestamp: string;
};

/**
 * A run of text, optionally a person's name. Names sit one step above
 * the rest of the line rather than at full text colour, which is the
 * whole reason the phrasing is returned in pieces instead of as one
 * string.
 */
type Segment = { text: string; name?: true };

/**
 * Turns one roster change into the words for it.
 *
 * Attribution is only ever added when the actor is someone else *and*
 * this device knows their name. An admin who added someone is named;
 * otherwise the line stands alone. Removal splits the same way, which is
 * what keeps leaving and being removed from reading identically.
 *
 * The person reading is "you", never their own name, which also flips the
 * sentence around: "Nadia added you", not "you were added by Nadia".
 *
 * Names go in verbatim — no initials, no truncation. Shortening "Maria
 * de la Cruz" to "Maria" guesses at which part is the given name, and
 * that guess is wrong for every family that puts it last. Long names wrap
 * instead; see `numberOfLines` below.
 */
export function describeMembershipEvent(event: MembershipEventItem): Segment[] {
  const you = (capitalized: boolean): Segment => ({ text: capitalized ? 'You' : 'you', name: true });
  const named = (name: string): Segment => ({ text: name, name: true });

  // Whoever leads the line is capitalized; a name in object position is not.
  const subject = event.subjectIsYou ? you(true) : named(event.subjectName);
  const subjectObject = event.subjectIsYou ? you(false) : named(event.subjectName);
  const actor: Segment | null = event.actorName === null ? null : named(event.actorName);
  const attributed = actor !== null && !event.selfInflicted;

  // `created` is decided at apply time, not inferred here — see
  // recordMemberAdded.
  if (event.kind === 'created') return [subject, { text: ' created this circle' }];

  if (event.kind === 'added') {
    if (!attributed) return [subject, { text: ' joined' }];
    if (event.actorIsYou) return [you(true), { text: ' added ' }, subjectObject];
    if (event.subjectIsYou) return [actor, { text: ' added ' }, you(false)];
    return [subject, { text: ' was added by ' }, actor];
  }

  if (event.kind === 'removed') {
    if (event.selfInflicted) return [subject, { text: ' left' }];
    if (!attributed) return [subject, { text: event.subjectIsYou ? ' are no longer in this circle' : ' is no longer in this circle' }];
    if (event.actorIsYou) return [you(true), { text: ' removed ' }, subjectObject];
    if (event.subjectIsYou) return [actor, { text: ' removed ' }, you(false)];
    return [subject, { text: ' was removed by ' }, actor];
  }

  const becameAdmin = event.role === 'admin';
  const verb = becameAdmin ? ' made ' : ' removed ';
  const suffix = becameAdmin ? ' an admin' : ' as an admin';

  if (!attributed) {
    if (becameAdmin) return [subject, { text: event.subjectIsYou ? ' are now an admin' : ' is now an admin' }];
    return [subject, { text: event.subjectIsYou ? ' are no longer an admin' : ' is no longer an admin' }];
  }
  if (event.actorIsYou) return [you(true), { text: verb }, subjectObject, { text: suffix }];
  if (event.subjectIsYou) return [actor, { text: verb }, you(false), { text: suffix }];
  return [actor, { text: verb }, subject, { text: suffix }];
}

/**
 * One roster change in the feed, drawn as a rule across the timeline
 * with the line of text at its centre. Deliberately the quietest thing
 * on the screen — no avatar, no card, one weight of type, nothing
 * colour-coded — so photographs stay the only thing carrying any visual
 * weight. The words say which kind it is.
 */
export function MembershipEventRow({ event }: { event: MembershipEventItem }) {
  const theme = useTheme();
  // In light mode muted/faint/faintest are the same value, so the token
  // ramp alone can't recede any further there — the opacity below is what
  // makes the row equally quiet in both.
  const rule = { backgroundColor: theme.faintest };

  return (
    <View style={styles.row}>
      <View style={[styles.rule, rule]} />
      {/* Two lines is enough for the longest realistic pair of full
          names; past that the tail is dropped rather than pushing the
          feed around. */}
      <ThemedText type="meta" themeColor="faintest" style={styles.text} numberOfLines={2}>
        {describeMembershipEvent(event).map((segment, index) =>
          segment.name ? (
            <ThemedText key={index} type="meta" themeColor="muted">
              {segment.text}
            </ThemedText>
          ) : (
            segment.text
          ),
        )}
        {' · '}
        {event.timestamp}
      </ThemedText>
      <View style={[styles.rule, rule]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.feedTextPadding,
    opacity: 0.75,
  },
  /**
   * Both rules take whatever the text leaves. `flexShrink` on the text
   * is what makes a long name wrap rather than squeeze them to nothing,
   * and `basis: 0` keeps the two of them the same length so the line
   * stays centred.
   */
  rule: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 8,
    height: StyleSheet.hairlineWidth,
  },
  text: {
    flexShrink: 1,
    textAlign: 'center',
  },
});
