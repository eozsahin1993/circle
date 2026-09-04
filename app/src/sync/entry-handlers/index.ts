import { commentHandler } from '@/sync/entry-handlers/comment';
import { memberAddedHandler } from '@/sync/entry-handlers/member-added';
import { postHandler } from '@/sync/entry-handlers/post';
import type { EntryHandler } from '@/sync/entry-handlers/types';

export type { EntryHandler } from '@/sync/entry-handlers/types';

/**
 * Meta entry types this build understands. An entry naming anything else
 * is discarded, which is the correct behaviour rather than a gap:
 * server/SYNC_DESIGN.md's invariant 5 is default-deny, and invariant 7
 * makes it recoverable — local state is a disposable projection, so a
 * later build that understands the type rebuilds it by replaying from
 * epoch 0.
 *
 * Not yet here, because nothing writes them yet: `key_rotation`,
 * `role_change`, `profile_update`, `circle_renamed`.
 */
export const metaHandlers: Record<string, EntryHandler> = {
  member_added: memberAddedHandler,
};

/** Content entry types this build understands. `reaction`/`delete` will join these when they start syncing. */
export const contentHandlers: Record<string, EntryHandler> = {
  post: postHandler,
  comment: commentHandler,
};
