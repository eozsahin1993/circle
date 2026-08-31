// expo-crypto has no native bridge under Jest, so `randomUUID()` silently
// returns nothing usable there — this mock backs it with Node's own
// crypto.randomUUID(), so tests get real, correctly-formatted RFC4122 v4
// UUIDs, not a fake/stubbed value. Auto-applied by Jest for any test that
// imports 'expo-crypto', no per-file jest.mock() call needed.
import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}
