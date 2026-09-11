import {
  describeMembershipEvent,
  describeMembershipEventGroup,
  type GroupedSubject,
  type MembershipEventGroupItem,
  type MembershipEventItem,
} from '@/components/membership-event-row';

function event(overrides: Partial<MembershipEventItem> = {}): MembershipEventItem {
  return {
    id: '1',
    kind: 'added',
    subjectName: 'Marcus',
    actorName: 'Nadia',
    selfInflicted: false,
    subjectIsYou: false,
    actorIsYou: false,
    role: null,
    ...overrides,
  };
}

/** The rendered sentence, with the name/plain distinction flattened away. */
const words = (item: MembershipEventItem) =>
  describeMembershipEvent(item)
    .map((segment) => segment.text)
    .join('');

describe('describeMembershipEvent', () => {
  test.each([
    ['an admin adding someone', event(), 'Marcus was added by Nadia'],
    ['a circle being created', event({ kind: 'created', selfInflicted: true, actorName: 'Marcus' }), 'Marcus created this circle'],
    ['an admin removing someone', event({ kind: 'removed' }), 'Marcus was removed by Nadia'],
    ['someone leaving', event({ kind: 'removed', selfInflicted: true, actorName: 'Marcus' }), 'Marcus left'],
    ['a promotion', event({ kind: 'role_changed', role: 'admin' }), 'Nadia made Marcus an admin'],
    ['a demotion', event({ kind: 'role_changed', role: 'member' }), 'Nadia removed Marcus as an admin'],
  ])('phrases %s', (_label, item, expected) => {
    expect(words(item)).toBe(expected);
  });

  test.each([
    ['an add whose admin is unknown here', event({ actorName: null }), 'Marcus joined'],
    ['a removal', event({ kind: 'removed', actorName: null }), 'Marcus is no longer in this circle'],
    ['a promotion', event({ kind: 'role_changed', role: 'admin', actorName: null }), 'Marcus is now an admin'],
    ['a demotion', event({ kind: 'role_changed', role: 'member', actorName: null }), 'Marcus is no longer an admin'],
  ])('drops attribution from %s when the actor is unknown to this device', (_label, item, expected) => {
    expect(words(item)).toBe(expected);
  });

  test.each([
    ['creating it yourself', event({ kind: 'created', selfInflicted: true, subjectIsYou: true, actorName: 'Marcus' }), 'You created this circle'],
    ['being added', event({ subjectIsYou: true }), 'Nadia added you'],
    ['adding someone', event({ actorIsYou: true }), 'You added Marcus'],
    ['leaving', event({ kind: 'removed', selfInflicted: true, subjectIsYou: true, actorName: 'Marcus' }), 'You left'],
    ['being removed', event({ kind: 'removed', subjectIsYou: true }), 'Nadia removed you'],
    ['removing someone', event({ kind: 'removed', actorIsYou: true }), 'You removed Marcus'],
    ['being promoted', event({ kind: 'role_changed', role: 'admin', subjectIsYou: true }), 'Nadia made you an admin'],
    ['promoting someone', event({ kind: 'role_changed', role: 'admin', actorIsYou: true }), 'You made Marcus an admin'],
    ['being demoted', event({ kind: 'role_changed', role: 'member', subjectIsYou: true }), 'Nadia removed you as an admin'],
  ])('addresses the reader in the second person when %s', (_label, item, expected) => {
    expect(words(item)).toBe(expected);
  });

  test.each([
    ['an add', event({ subjectIsYou: true, actorName: null }), 'You joined'],
    ['a removal', event({ kind: 'removed', subjectIsYou: true, actorName: null }), 'You are no longer in this circle'],
    ['a promotion', event({ kind: 'role_changed', role: 'admin', subjectIsYou: true, actorName: null }), 'You are now an admin'],
    ['a demotion', event({ kind: 'role_changed', role: 'member', subjectIsYou: true, actorName: null }), 'You are no longer an admin'],
  ])('agrees the verb with "you" on unattributed %s', (_label, item, expected) => {
    expect(words(item)).toBe(expected);
  });

  test('emphasises the names and nothing else', () => {
    const segments = describeMembershipEvent(event({ kind: 'role_changed', role: 'admin' }));

    expect(segments.filter((segment) => segment.name).map((segment) => segment.text)).toEqual(['Nadia', 'Marcus']);
  });

  /**
   * Names go in whole — abbreviating would mean guessing which part is
   * the given name, which is wrong for every family that puts it last.
   */
  test('keeps long names verbatim', () => {
    const long = 'María de la Cruz Fernández de Córdoba';

    expect(words(event({ subjectName: long }))).toBe(`${long} was added by Nadia`);
  });
});

function subject(name: string, isYou = false): GroupedSubject {
  return { subjectName: name, subjectIsYou: isYou };
}

function group(overrides: Partial<MembershipEventGroupItem> = {}): MembershipEventGroupItem {
  return {
    kind: 'added',
    role: null,
    selfInflicted: false,
    actorName: 'Nadia',
    actorIsYou: false,
    subjects: [subject('Tomas'), subject('Priya'), subject('Yaa'), subject('Lin'), subject('Emre'), subject('Rosamund'), subject('Ayo')],
    ...overrides,
  };
}

/** The rendered sentence, with the name/plain/interactive distinction flattened away. */
const groupWords = (item: MembershipEventGroupItem, expanded = false) =>
  describeMembershipEventGroup(item, expanded)
    .map((segment) => segment.text)
    .join('');

describe('describeMembershipEventGroup', () => {
  test('collapsed, names the first two and folds the rest into "and N others"', () => {
    expect(groupWords(group())).toBe('Nadia added Tomas, Priya and 5 others');
  });

  test('expanded, names everyone with no fold', () => {
    expect(groupWords(group(), true)).toBe('Nadia added Tomas, Priya, Yaa, Lin, Emre, Rosamund and Ayo');
  });

  test('exactly two subjects need no fold even collapsed', () => {
    expect(groupWords(group({ subjects: [subject('Tomas'), subject('Priya')] }))).toBe('Nadia added Tomas and Priya');
  });

  test('the fold is marked interactive; nothing else is', () => {
    const segments = describeMembershipEventGroup(group(), false);

    expect(segments.filter((s) => s.interactive).map((s) => s.text)).toEqual(['5 others']);
  });

  test('unattributed add: subjects lead, "joined" is invariant under pluralization', () => {
    expect(groupWords(group({ actorName: null }))).toBe('Tomas, Priya and 5 others joined');
  });

  test('the actor being the reader', () => {
    expect(groupWords(group({ actorIsYou: true }))).toBe('You added Tomas, Priya and 5 others');
  });

  test('several people leaving the same day (self-inflicted, no actor to attribute)', () => {
    const departures = group({ kind: 'removed', selfInflicted: true, actorName: null, subjects: [subject('Tomas'), subject('Priya'), subject('Yaa')] });

    expect(groupWords(departures)).toBe('Tomas, Priya and 1 other left');
  });

  test('an admin removing several people', () => {
    const removed = group({ kind: 'removed', subjects: [subject('Tomas'), subject('Priya')] });

    expect(groupWords(removed)).toBe('Nadia removed Tomas and Priya');
  });

  test('a removal nobody here can attribute', () => {
    const removed = group({ kind: 'removed', actorName: null, subjects: [subject('Tomas'), subject('Priya')] });

    expect(groupWords(removed)).toBe('Tomas and Priya are no longer in this circle');
  });

  test('several promotions', () => {
    const promoted = group({ kind: 'role_changed', role: 'admin', subjects: [subject('Tomas'), subject('Priya')] });

    expect(groupWords(promoted)).toBe('Nadia made Tomas and Priya admins');
  });

  test('several demotions', () => {
    const demoted = group({ kind: 'role_changed', role: 'member', subjects: [subject('Tomas'), subject('Priya')] });

    expect(groupWords(demoted)).toBe('Nadia removed Tomas and Priya as admins');
  });

  test('unattributed promotions/demotions pluralize the verb too', () => {
    const promoted = group({ kind: 'role_changed', role: 'admin', actorName: null, subjects: [subject('Tomas'), subject('Priya')] });
    const demoted = group({ kind: 'role_changed', role: 'member', actorName: null, subjects: [subject('Tomas'), subject('Priya')] });

    expect(groupWords(promoted)).toBe('Tomas and Priya are now admins');
    expect(groupWords(demoted)).toBe('Tomas and Priya are no longer admins');
  });

  /** Only the very first word of the whole line ever gets capitalized — never a "you" further into the list. */
  test('capitalizes a leading "you" but not one later in the list', () => {
    const leading = group({ actorName: null, subjects: [subject('Nana', true), subject('Priya')] });
    const later = group({ actorName: null, subjects: [subject('Priya'), subject('Nana', true)] });

    expect(groupWords(leading)).toBe('You and Priya joined');
    expect(groupWords(later)).toBe('Priya and you joined');
  });
});
