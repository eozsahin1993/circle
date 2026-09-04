/**
 * Whether a failed local write can never succeed, however many times it's
 * retried — as opposed to one that failed for a passing reason.
 *
 * The sync walker needs this distinction to decide between skipping an
 * entry and stopping the pass. Getting it wrong is costly in one
 * direction: treating a transient failure as permanent advances the
 * cursor past the entry, and since cursors never rewind, that entry is
 * gone from this device's projection until something replays the log from
 * epoch 0.
 *
 * Only constraint violations qualify. A foreign key that doesn't resolve
 * means the entry depends on something this device doesn't have and
 * won't get — typically because that dependency was itself skipped. Busy
 * or locked databases, full disks and I/O errors are all the other case,
 * and they heal on their own.
 */
export function isPermanentWriteFailure(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}
