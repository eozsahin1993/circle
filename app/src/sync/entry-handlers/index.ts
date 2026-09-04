import { EntryTypes } from '@/domain/usecases/circle/log-entry';
import { commentHandler } from '@/sync/entry-handlers/comment';
import { keyRotationHandler } from '@/sync/entry-handlers/key-rotation';
import { memberAddedHandler } from '@/sync/entry-handlers/member-added';
import { memberRemovedHandler } from '@/sync/entry-handlers/member-removed';
import { postHandler } from '@/sync/entry-handlers/post';
import { reactionHandler } from '@/sync/entry-handlers/reaction';
import { roleChangeHandler } from '@/sync/entry-handlers/role-change';
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
 * Not yet here, because nothing writes them yet: `profile_update`, `circle_renamed`.
 */
export const metaHandlers: Record<string, EntryHandler> = {
  [EntryTypes.MEMBER_ADDED]: memberAddedHandler,
  [EntryTypes.MEMBER_REMOVED]: memberRemovedHandler,
  [EntryTypes.ROLE_CHANGE]: roleChangeHandler,
  [EntryTypes.KEY_ROTATION]: keyRotationHandler,
};

/** Content entry types this build understands. `delete` will join these when tombstones are built. */
export const contentHandlers: Record<string, EntryHandler> = {
  [EntryTypes.POST]: postHandler,
  [EntryTypes.COMMENT]: commentHandler,
  [EntryTypes.REACTION]: reactionHandler,
};
