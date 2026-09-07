import { outbox } from '@/data/db/schema';
import { EntryTypes, type EntryType } from '@/domain/usecases/circle/log-entry';
import { namespaceFor } from '@/domain/usecases/circle/sync-circle';
import { contentHandlers, metaHandlers } from '@/sync/entry-handlers';

/**
 * Two silent, permanent bugs came from this wiring being wrong, both
 * invisible on the authoring device because it applies its own
 * optimistic copy: `profile_update` was pushed to the content namespace
 * where no handler reads it, and `cover_photo_set` was written with no
 * handler registered at all. Neither surfaced as an error — the entry is
 * fetched, logged as an unknown type, and skipped forever.
 */

function namespaceOfHandler(type: string): 'meta' | 'content' | null {
  if (metaHandlers[type]) return 'meta';
  if (contentHandlers[type]) return 'content';
  return null;
}

const ENTRY_TYPES = Object.values(EntryTypes);

test.each(ENTRY_TYPES)('%s has a handler registered', (type) => {
  expect(namespaceOfHandler(type)).not.toBeNull();
});

test('no entry type is registered in both namespaces', () => {
  const both = ENTRY_TYPES.filter((type) => metaHandlers[type] && contentHandlers[type]);
  expect(both).toEqual([]);
});

test('every registered handler names a real entry type', () => {
  const registered = [...Object.keys(metaHandlers), ...Object.keys(contentHandlers)];
  expect(registered.filter((type) => !ENTRY_TYPES.includes(type as EntryType))).toEqual([]);
});

test.each(outbox.entryType.enumValues)('%s is pushed to the namespace its handler reads', (type) => {
  expect(namespaceFor(type)).toBe(namespaceOfHandler(type));
});

test('the outbox can queue every entry type', () => {
  // A type missing from the column enum can't be queued at all — the
  // insert fails at runtime, not at compile time.
  expect(ENTRY_TYPES.filter((type) => !outbox.entryType.enumValues.includes(type))).toEqual([]);
});
