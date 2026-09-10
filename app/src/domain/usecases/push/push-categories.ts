/**
 * Bit layout of the category mask the relay stores per circle:
 *
 *     bit 0   newPost
 *     bit 1   comment
 *     bit 2   reaction
 *     bit 3   memberJoined
 *
 * Positions are permanent. Masks written with this layout are already on
 * devices and in relay rows, so moving one changes what every stored mask
 * means — someone who asked for comments starts getting reactions, and
 * nothing errors. Add at the next free bit; never edit a line above.
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
