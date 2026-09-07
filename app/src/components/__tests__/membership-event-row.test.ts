import { describeMembershipEvent, type MembershipEventItem } from '@/components/membership-event-row';

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
    timestamp: '2h',
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
