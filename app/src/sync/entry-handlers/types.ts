import { getMemberByPublicKey } from '@/data/db';
import type { LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';

/**
 * One entry type's rules, as a pair of small functions. The walker
 * (pull-log.ts) knows only this shape and the tables below — it never
 * branches on an entry type, so supporting a new one means adding a
 * handler and a table row, never touching the walk itself. That's
 * server/SYNC_DESIGN.md's "Adding a type should mean adding a row to the
 * predicate table — not adding a mechanism", taken literally.
 */
export type EntryHandler = {
  /**
   * May this author do this, given what the device knows *right now*
   * (entries before this one have already been applied)? False discards
   * the entry permanently — so this must express a rule that can never
   * later become true, not "can't tell yet".
   */
  predicate(circleId: string, envelope: LogEntryEnvelope): Promise<boolean>;
  /**
   * Applies the entry locally. Must be idempotent: a crash between
   * applying an entry and advancing the cursor replays it, and a joiner
   * walking meta from epoch 0 meets its own self-announced entries
   * (server/SYNC_DESIGN.md invariant 8).
   */
  apply(circleId: string, envelope: LogEntryEnvelope): Promise<void>;
};

/** Convenience for handlers, which all start by narrowing `payload` from `unknown`. */
export function asRecord(payload: unknown): Record<string, unknown> | null {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
}

/**
 * The predicate nearly every content type wants: the author is someone
 * this device has seen join. Membership is "has ever been a member", not
 * "is one now" — removing someone doesn't retract their old content
 * (server/SYNC_DESIGN.md's ever-member set). `getMemberByPublicKey` reads
 * the same `circle_members` table `getCircleMembers` does, but
 * deliberately doesn't filter out removed rows the way that one does —
 * see `removedAt` on the schema and member-removed.ts's handler.
 */
export async function authoredByMember(circleId: string, envelope: LogEntryEnvelope): Promise<boolean> {
  return (await getMemberByPublicKey(circleId, envelope.authorPubkey)) !== null;
}

/** Narrows a payload field, returning null the moment anything is the wrong shape. */
export function stringField(record: Record<string, unknown>, key: string, { allowEmpty = false } = {}): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  if (!allowEmpty && !value) return null;
  return value;
}

export function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' ? value : null;
}
