import { useState } from 'react';
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
};

/**
 * A run of text, optionally a person's name. Names sit one step above
 * the rest of the line rather than at full text colour, which is the
 * whole reason the phrasing is returned in pieces instead of as one
 * string. `interactive` marks the one segment (per line, at most) that
 * toggles a group's expansion — see `describeMembershipEventGroup`.
 */
type Segment = { text: string; name?: true; interactive?: true };

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

/** One subject inside a group — enough to name them, nothing else. */
export type GroupedSubject = { subjectName: string; subjectIsYou: boolean };

/**
 * Several roster changes sharing a day, an actor (or none, for a
 * self-inflicted kind), and an action — see `group-member-events.ts`,
 * which is what actually builds these. `subjects` is oldest first, so
 * truncating from the end hides the most recent people rather than the
 * first.
 */
export type MembershipEventGroupItem = {
  /** Includes `created` only so a solo group can pass it straight to `describeMembershipEvent` — a circle has exactly one founder, so it's never anything but solo. */
  kind: 'created' | 'added' | 'removed' | 'role_changed';
  role: 'admin' | 'member' | null;
  selfInflicted: boolean;
  actorName: string | null;
  actorIsYou: boolean;
  subjects: GroupedSubject[];
};

/** How many subjects a collapsed group names before folding the rest into "and N others". */
export const GROUP_PREVIEW_COUNT = 2;

/** "A" | "A and B" | "A, B and C" — the last item never gets a leading comma, only "and". */
function andJoin(items: Segment[]): Segment[] {
  if (items.length <= 1) return items;
  const out: Segment[] = [];
  items.slice(0, -1).forEach((item, index) => {
    out.push(item);
    out.push({ text: index === items.length - 2 ? ' and ' : ', ' });
  });
  out.push(items[items.length - 1]);
  return out;
}

/** "you" only capitalizes when it's the very first word — never mid-sentence, even inside a list. */
function capitalizeLeadingYou(segments: Segment[]): Segment[] {
  const [first, ...rest] = segments;
  if (!first || first.text !== 'you') return segments;
  return [{ ...first, text: 'You' }, ...rest];
}

/**
 * `describeMembershipEvent`, generalized to several subjects. Only ever
 * called for a group of more than one — a solo group renders through
 * `describeMembershipEvent` instead (see `MembershipEventGroupRow`).
 *
 * `expanded` decides how many subjects are named before the rest fold
 * into "and N others" — that fold is part of the sentence's own grammar;
 * "Show less" isn't, and gets appended after the sentence by the caller.
 */
export function describeMembershipEventGroup(group: MembershipEventGroupItem, expanded: boolean): Segment[] {
  const named = (name: string): Segment => ({ text: name, name: true });
  const subjectItem = (s: GroupedSubject): Segment => (s.subjectIsYou ? { text: 'you', name: true } : named(s.subjectName));

  const visible = expanded ? group.subjects : group.subjects.slice(0, GROUP_PREVIEW_COUNT);
  const hiddenCount = group.subjects.length - visible.length;
  const others: Segment[] = hiddenCount > 0 ? [{ text: `${hiddenCount} other${hiddenCount === 1 ? '' : 's'}`, interactive: true }] : [];
  const subjectList = andJoin([...visible.map(subjectItem), ...others]);

  const actor: Segment | null = group.actorName === null ? null : named(group.actorName);
  const attributed = actor !== null && !group.selfInflicted;

  if (group.kind === 'added') {
    if (!attributed) return [...capitalizeLeadingYou(subjectList), { text: ' joined' }];
    if (group.actorIsYou) return [{ text: 'You', name: true }, { text: ' added ' }, ...subjectList];
    return [actor as Segment, { text: ' added ' }, ...subjectList];
  }

  if (group.kind === 'removed') {
    // Self-inflicted here always means "left" — see group-member-events.ts's groupKey.
    if (group.selfInflicted) return [...capitalizeLeadingYou(subjectList), { text: ' left' }];
    if (!attributed) return [...capitalizeLeadingYou(subjectList), { text: ' are no longer in this circle' }];
    if (group.actorIsYou) return [{ text: 'You', name: true }, { text: ' removed ' }, ...subjectList];
    return [actor as Segment, { text: ' removed ' }, ...subjectList];
  }

  // Only `role_changed` reaches here — `created` is excluded by the
  // one-founder-ever invariant on `MembershipEventGroupItem.kind`.
  const becameAdmin = group.role === 'admin';
  const verb = becameAdmin ? ' made ' : ' removed ';
  const suffix = becameAdmin ? ' admins' : ' as admins';

  if (!attributed) {
    return [...capitalizeLeadingYou(subjectList), { text: becameAdmin ? ' are now admins' : ' are no longer admins' }];
  }
  if (group.actorIsYou) return [{ text: 'You', name: true }, { text: verb }, ...subjectList, { text: suffix }];
  return [actor as Segment, { text: verb }, ...subjectList, { text: suffix }];
}

/**
 * One roster change, or a group of several sharing a day, actor and
 * action — plain left-aligned text, no rule of its own; the day block's
 * header above it (see `DayDivider`) carries the only rule in the group.
 * A solo group renders the ordinary singular phrasing with no expand
 * affordance, so grouping is invisible until there's more than one to fold.
 */
export function MembershipEventGroupRow({ group }: { group: MembershipEventGroupItem }) {
  const [expanded, setExpanded] = useState(false);

  const solo = group.subjects.length === 1;
  const segments = solo
    ? describeMembershipEvent({
        id: '',
        kind: group.kind,
        subjectName: group.subjects[0].subjectName,
        actorName: group.actorName,
        selfInflicted: group.selfInflicted,
        subjectIsYou: group.subjects[0].subjectIsYou,
        actorIsYou: group.actorIsYou,
        role: group.role,
      })
    : describeMembershipEventGroup(group, expanded);
  // Only a truncatable group ever gets a "Show less" — expanding a group
  // that was never folded in the first place has nothing to collapse back to.
  const collapsible = !solo && group.subjects.length > GROUP_PREVIEW_COUNT;

  return (
    <View style={styles.plainRow}>
      {/* Two lines is enough for the longest realistic pair of full
          names; past that the tail is dropped rather than pushing the
          feed around. */}
      <ThemedText type="meta" themeColor="faintest" style={styles.text} numberOfLines={2}>
        {segments.map((segment, index) =>
          segment.interactive ? (
            <ThemedText key={index} type="meta" themeColor="accent" onPress={() => setExpanded((current) => !current)}>
              {segment.text}
            </ThemedText>
          ) : segment.name ? (
            <ThemedText key={index} type="meta" themeColor="secondary">
              {segment.text}
            </ThemedText>
          ) : (
            segment.text
          ),
        )}
        {collapsible && expanded && (
          <ThemedText type="meta" themeColor="accent" onPress={() => setExpanded((current) => !current)}>
            {' Show less'}
          </ThemedText>
        )}
      </ThemedText>
    </View>
  );
}

/**
 * The header above a block of roster changes — everything under it
 * happened the same day, until either the day changes or a post
 * interrupts it (see `group-member-events.ts`). The only rule-flanked row
 * in the group; every change under it is plain text (see
 * `MembershipEventGroupRow`), so the rule reads as marking a day rather
 * than being repeated once per line the way it used to be.
 */
export function DayDivider({ day }: { day: string }) {
  const theme = useTheme();
  const rule = { backgroundColor: theme.faintest };

  return (
    <View style={styles.row}>
      <View style={[styles.rule, rule]} />
      <ThemedText type="meta" themeColor="faintest" style={styles.dayText}>
        {day.toUpperCase()}
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
   * No `alignItems` override: the text must stretch to the row's full
   * width, or `numberOfLines` wraps against its shrunk-to-content
   * measurement instead and truncates with an ellipsis well short of the
   * actual edge of the screen.
   */
  plainRow: {
    paddingHorizontal: Spacing.feedTextPadding,
    opacity: 0.75,
  },
  /**
   * `flexGrow`/`flexBasis: 0` split whatever the text leaves evenly
   * between the two rules. `height: 1`, not `hairlineWidth` (one *device*
   * pixel): at a hairline, the list translating during a scroll lands on
   * fractional offsets and rasterises differently row to row, so the line
   * visibly shimmers.
   */
  rule: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 8,
    height: 1,
  },
  text: {
    flexShrink: 1,
    textAlign: 'left',
  },
  dayText: {
    letterSpacing: 1.5,
  },
});
