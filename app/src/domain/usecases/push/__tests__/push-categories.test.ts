import { PushCategories } from '@/domain/usecases/push/push-categories';

/**
 * Pinned deliberately, not merely asserted. These are bit positions inside
 * masks already stored on devices and in the relay's prefs rows, so
 * renumbering one silently changes what every stored mask means — someone
 * who asked for comments starts getting reactions, and nothing errors.
 *
 * Adding a category means a new line here with the next free value. Editing
 * an existing line is what this exists to stop.
 */
test('category values are permanent', () => {
  expect(PushCategories).toEqual({
    newPost: 0,
    comment: 1,
    reaction: 2,
    memberJoined: 3,
  });
});
