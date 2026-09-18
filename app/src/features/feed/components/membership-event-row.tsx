import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/ui/theme/themed-text';
import { Spacing } from '@/ui/theme/tokens';
import { useTheme } from '@/ui/theme/hooks/use-theme';
import { upperCase } from '@/core/i18n/text';
import { useLanguage } from '@/core/i18n/use-language';

export type MembershipEventItem = {
  id: string;
  kind: 'created' | 'added' | 'removed' | 'role_changed' | 'account_deleted';
  subjectName: string;
  /** Null when this device never saw the actor join — the line renders unattributed rather than guessing. */
  actorName: string | null;
  /** The subject acted on themselves: founding the circle, leaving it, or deleting their account. */
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

type Slot = 'subject' | 'actor' | 'list' | 'first' | 'second';

/**
 * Handed to `t` in place of the real values, so each sentence is
 * translated whole and cut back into segments afterwards. Names never go
 * through `t` themselves, so nothing in one can be mistaken for a slot or
 * a tag.
 */
const slots: Record<Slot, string> = {
  subject: '\u0001subject\u0001',
  actor: '\u0001actor\u0001',
  list: '\u0001list\u0001',
  first: '\u0001first\u0001',
  second: '\u0001second\u0001',
};

/** Slots become their parts; `<name>` marks a fixed word — "you" — that reads as a name. */
function toSegments(sentence: string, parts: Partial<Record<Slot, Segment[]>>): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of sentence.matchAll(/\u0001(\w+)\u0001|<name>(.*?)<\/name>/g)) {
    if (match.index > last) out.push({ text: sentence.slice(last, match.index) });
    if (match[1] !== undefined) out.push(...(parts[match[1] as Slot] ?? []));
    else out.push({ text: match[2], name: true });
    last = match.index + match[0].length;
  }
  if (last < sentence.length) out.push({ text: sentence.slice(last) });
  return out;
}

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
export function describeMembershipEvent(event: MembershipEventItem, t: TFunction): Segment[] {
  const subject: Segment[] = [{ text: event.subjectName, name: true }];
  const actor: Segment[] | null = event.actorName === null ? null : [{ text: event.actorName, name: true }];
  const attributed = actor !== null && !event.selfInflicted;
  const you = event.subjectIsYou;
  const say = (sentence: string) => toSegments(sentence, { subject, actor: actor ?? [] });

  // `created` is decided at apply time, not inferred here — see
  // recordMemberAdded.
  if (event.kind === 'created') return say(you ? t('feed.membership.youCreated') : t('feed.membership.created', slots));

  if (event.kind === 'added') {
    if (!attributed) return say(you ? t('feed.membership.youJoined') : t('feed.membership.joined', slots));
    if (event.actorIsYou) return say(t('feed.membership.youAdded', slots));
    if (you) return say(t('feed.membership.addedYou', slots));
    return say(t('feed.membership.addedBy', slots));
  }

  // Always self-inflicted (nobody deletes an account but its own), and
  // its own kind rather than `removed` plus a flag — a different reason
  // for leaving, not a special case of "left".
  if (event.kind === 'account_deleted') {
    return say(you ? t('feed.membership.youDeletedAccount') : t('feed.membership.deletedAccount', slots));
  }

  if (event.kind === 'removed') {
    if (event.selfInflicted) return say(you ? t('feed.membership.youLeft') : t('feed.membership.left', slots));
    if (!attributed) return say(you ? t('feed.membership.youNotInCircle') : t('feed.membership.notInCircle', slots));
    if (event.actorIsYou) return say(t('feed.membership.youRemoved', slots));
    if (you) return say(t('feed.membership.removedYou', slots));
    return say(t('feed.membership.removedBy', slots));
  }

  const becameAdmin = event.role === 'admin';

  if (!attributed) {
    if (becameAdmin) return say(you ? t('feed.membership.youNowAdmin') : t('feed.membership.nowAdmin', slots));
    return say(you ? t('feed.membership.youNoLongerAdmin') : t('feed.membership.noLongerAdmin', slots));
  }
  if (event.actorIsYou) {
    return say(becameAdmin ? t('feed.membership.youMadeAdmin', slots) : t('feed.membership.youRemovedAdmin', slots));
  }
  if (you) return say(becameAdmin ? t('feed.membership.madeYouAdmin', slots) : t('feed.membership.removedYouAdmin', slots));
  return say(becameAdmin ? t('feed.membership.madeAdmin', slots) : t('feed.membership.removedAdmin', slots));
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
  kind: 'created' | 'added' | 'removed' | 'role_changed' | 'account_deleted';
  role: 'admin' | 'member' | null;
  selfInflicted: boolean;
  actorName: string | null;
  actorIsYou: boolean;
  subjects: GroupedSubject[];
};

/** How many subjects a collapsed group names before folding the rest into "and N others". */
export const GROUP_PREVIEW_COUNT = 2;

/** "A" | "A and B" | "A, B and C" — the last item never gets a leading comma, only "and". */
function andJoin(items: Segment[], t: TFunction): Segment[] {
  if (items.length <= 1) return items;
  const head = items.slice(0, -1).flatMap((item, index) => (index === 0 ? [item] : [{ text: t('feed.membership.listSeparator') }, item]));
  return toSegments(t('feed.membership.listPair', slots), { first: head, second: [items[items.length - 1]] });
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
export function describeMembershipEventGroup(group: MembershipEventGroupItem, expanded: boolean, t: TFunction): Segment[] {
  const you: Segment = { text: t('feed.membership.you'), name: true };
  const subjectItem = (s: GroupedSubject): Segment => (s.subjectIsYou ? you : { text: s.subjectName, name: true });

  const visible = expanded ? group.subjects : group.subjects.slice(0, GROUP_PREVIEW_COUNT);
  const hiddenCount = group.subjects.length - visible.length;
  const others: Segment[] = hiddenCount > 0 ? [{ text: t('feed.membership.others', { count: hiddenCount }), interactive: true }] : [];
  const list = andJoin([...visible.map(subjectItem), ...others], t);

  const actor: Segment[] = group.actorName === null ? [] : [{ text: group.actorName, name: true }];
  const attributed = group.actorName !== null && !group.selfInflicted;

  // "you" only capitalizes when it's the very first word — never mid-sentence, even inside a list.
  const say = (sentence: string) => {
    const segments = toSegments(sentence, { list, actor });
    return segments[0] === you ? [{ ...you, text: t('feed.membership.youLeading') }, ...segments.slice(1)] : segments;
  };

  if (group.kind === 'added') {
    if (!attributed) return say(t('feed.membership.group.joined', slots));
    if (group.actorIsYou) return say(t('feed.membership.group.youAdded', slots));
    return say(t('feed.membership.group.added', slots));
  }

  // Its own kind, not `removed` plus a flag — see group-member-events.ts's
  // groupKey, which is what keeps a group's subjects from ever mixing
  // "left" with "deleted their account".
  if (group.kind === 'account_deleted') return say(t('feed.membership.group.deletedAccounts', slots));

  if (group.kind === 'removed') {
    // Self-inflicted here always means "left" — see group-member-events.ts's groupKey.
    if (group.selfInflicted) return say(t('feed.membership.group.left', slots));
    if (!attributed) return say(t('feed.membership.group.notInCircle', slots));
    if (group.actorIsYou) return say(t('feed.membership.group.youRemoved', slots));
    return say(t('feed.membership.group.removed', slots));
  }

  // Only `role_changed` reaches here — `created` is excluded by the
  // one-founder-ever invariant on `MembershipEventGroupItem.kind`.
  const becameAdmin = group.role === 'admin';

  if (!attributed) {
    return say(becameAdmin ? t('feed.membership.group.nowAdmins', slots) : t('feed.membership.group.noLongerAdmins', slots));
  }
  if (group.actorIsYou) {
    return say(becameAdmin ? t('feed.membership.group.youMadeAdmins', slots) : t('feed.membership.group.youRemovedAdmins', slots));
  }
  return say(becameAdmin ? t('feed.membership.group.madeAdmins', slots) : t('feed.membership.group.removedAdmins', slots));
}

/**
 * One roster change, or a group of several sharing a day, actor and
 * action — plain left-aligned text, no rule of its own; the day block's
 * header above it (see `DayDivider`) carries the only rule in the group.
 * A solo group renders the ordinary singular phrasing with no expand
 * affordance, so grouping is invisible until there's more than one to fold.
 */
export function MembershipEventGroupRow({ group }: { group: MembershipEventGroupItem }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const solo = group.subjects.length === 1;
  const segments = solo
    ? describeMembershipEvent(
        {
          id: '',
          kind: group.kind,
          subjectName: group.subjects[0].subjectName,
          actorName: group.actorName,
          selfInflicted: group.selfInflicted,
          subjectIsYou: group.subjects[0].subjectIsYou,
          actorIsYou: group.actorIsYou,
          role: group.role,
        },
        t,
      )
    : describeMembershipEventGroup(group, expanded, t);
  // Only a truncatable group ever gets a "Show less" — expanding a group
  // that was never folded in the first place has nothing to collapse back to.
  const collapsible = !solo && group.subjects.length > GROUP_PREVIEW_COUNT;

  return (
    <View style={styles.plainRow}>
      {/* Two lines is enough for the longest realistic pair of full
          names; past that the tail is dropped rather than pushing the
          feed around. */}
      <ThemedText type="labelSmall" themeColor="faintest" style={styles.text} numberOfLines={2}>
        {segments.map((segment, index) =>
          segment.interactive ? (
            <ThemedText key={index} type="labelSmall" themeColor="accent" onPress={() => setExpanded((current) => !current)}>
              {segment.text}
            </ThemedText>
          ) : segment.name ? (
            <ThemedText key={index} type="labelSmall" themeColor="secondary">
              {segment.text}
            </ThemedText>
          ) : (
            segment.text
          ),
        )}
        {collapsible && expanded && (
          <ThemedText type="labelSmall" themeColor="accent" onPress={() => setExpanded((current) => !current)}>
            {` ${t('feed.membership.showLess')}`}
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
  const language = useLanguage();
  const theme = useTheme();
  const rule = { backgroundColor: theme.faintest };

  return (
    <View style={styles.row}>
      <View style={[styles.rule, rule]} />
      <ThemedText type="labelSmall" themeColor="faintest" style={styles.dayText}>
        {upperCase(day, language)}
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
