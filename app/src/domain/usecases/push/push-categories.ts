/**
 * Bit positions in the relay's category mask, so these values are
 * permanent — add to the end, never renumber.
 *
 * Its own module, with no imports: both `sync-circle` and
 * `push-registration` need it, and those two already depend on each other.
 */
export const PushCategories = {
  newPost: 0,
  comment: 1,
  reaction: 2,
  memberJoined: 3,
} as const;

export type PushCategory = (typeof PushCategories)[keyof typeof PushCategories];
