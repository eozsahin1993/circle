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
