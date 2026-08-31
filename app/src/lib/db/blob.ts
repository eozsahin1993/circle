/**
 * A BLOB column can come back as a Node `Buffer` (as `better-sqlite3` in the
 * test mock returns) rather than a plain `Uint8Array` — and `Buffer` *is* a
 * `Uint8Array` subclass, so a naive `instanceof Uint8Array` check doesn't
 * catch it, even though `toEqual` treats them as different constructors. It
 * can also arrive as a JSON-serialized `{ type: 'Buffer', data: [...] }`
 * plain object (observed crossing Jest's worker-process IPC boundary).
 * Always rebuild a plain Uint8Array so callers get a consistent type no
 * matter which shape the underlying binding actually handed back.
 */
export function normalizeBlob(value: unknown): Uint8Array | null {
  if (value == null) return null;
  if (typeof value === 'object' && !ArrayBuffer.isView(value) && 'data' in (value as { data?: unknown })) {
    return new Uint8Array((value as { data: number[] }).data);
  }
  return new Uint8Array(value as ArrayLike<number>);
}
