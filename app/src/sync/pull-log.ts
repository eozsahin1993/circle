import { advanceCircleCursor, getCircle } from '@/data/db';
import { verifyLogEntry } from '@/domain/usecases/circle/log-entry';
import { getCircleKeyMap } from '@/services/keystore';
import { fetchEntries, type Namespace } from '@/services/relay';
import { contentHandlers, metaHandlers, type EntryHandler } from '@/sync/entry-handlers';

/**
 * Walks one namespace of a circle's log from where this device left off,
 * applying what it understands and advancing the cursor as it goes.
 *
 * **Two kinds of failure, deliberately handled differently.** A
 * *transient* failure — the fetch throwing, or a handler failing on a
 * local write — stops the pass where it stands. The cursor keeps whatever
 * it was last advanced to, so the next trigger resumes rather than
 * restarts, and nothing is skipped. An entry that is *permanently*
 * unusable — no key for its version, a bad signature, malformed, an
 * unknown type, a failed predicate — is logged, skipped, and walked past;
 * it can never become valid, and stopping on it would wedge the circle
 * forever. That's invariant 5's default-deny, and invariant 7 is why
 * skipping is safe: local state is a disposable projection of a permanent
 * log, so anything skipped is recoverable by replaying from epoch 0.
 *
 * The cursor only ever advances to the last entry actually *processed*,
 * never to the relay's reported `currentEpoch` — a short page would
 * otherwise silently skip everything it didn't return.
 */
async function pull(circleId: string, namespace: Namespace, handlers: Record<string, EntryHandler>): Promise<void> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('No local circle row for this id.');

  const keyMap = await getCircleKeyMap(circleId);
  if (!keyMap) throw new Error('No content keys on this device for this circle.');

  let cursor = namespace === 'meta' ? circle.metaCursor : circle.contentCursor;

  for (;;) {
    const { entries, currentEpoch } = await fetchEntries(circle.syncId, namespace, cursor);
    if (entries.length === 0) return;

    for (const entry of entries) {
      const key = keyMap[entry.keyVersion];
      const envelope = key ? verifyLogEntry(entry.encryptedMeta, key) : null;
      const handler = envelope ? handlers[envelope.type] : undefined;

      if (!key) {
        console.warn(`Skipping ${namespace} entry ${entry.epoch}: no content key for version ${entry.keyVersion}`);
      } else if (!envelope) {
        console.warn(`Skipping ${namespace} entry ${entry.epoch}: failed to decrypt or verify`);
      } else if (!handler) {
        console.warn(`Skipping ${namespace} entry ${entry.epoch}: unknown type ${envelope.type}`);
      } else if (!(await handler.predicate(circleId, envelope))) {
        console.warn(`Skipping ${namespace} entry ${entry.epoch}: ${envelope.type} rejected by its predicate`);
      } else {
        // Anything thrown here is transient (a local write failing), so
        // it propagates and ends the pass with the cursor still behind
        // this entry — it gets retried, not skipped.
        await handler.apply(circleId, envelope);
      }

      cursor = entry.epoch;
    }

    await advanceCircleCursor(circleId, namespace, cursor);
    if (cursor >= currentEpoch) return;
  }
}

/**
 * Replays every meta entry — identities, roster, roles. Must complete
 * before content is touched: a content entry can't be decrypted without
 * the key version meta introduces, and can't be attributed without the
 * author meta announces (server/SYNC_DESIGN.md's "Read / sync").
 */
export function pullMeta(circleId: string): Promise<void> {
  return pull(circleId, 'meta', metaHandlers);
}

/** Replays content entries — posts today. Only meaningful after `pullMeta` has caught up. */
export function pullContent(circleId: string): Promise<void> {
  return pull(circleId, 'content', contentHandlers);
}
