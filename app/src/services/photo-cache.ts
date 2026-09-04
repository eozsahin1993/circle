import { Directory, File, Paths } from 'expo-file-system';

import { COVER_ENTRY_ID } from '@/data/db/attachments';

/**
 * Decrypted photos, written once to disk so screens can hand `<Image>` a
 * `file://` path instead of a base64 data URI.
 *
 * A data URI costs on both sides of the bridge every single render: the
 * JS thread base64-encodes the bytes (~85ms for three photos on a Galaxy
 * S10e), then a string of roughly four-thirds the file size is serialized
 * into the native tree and decoded again. Navigating in and out of a
 * feed repeats all of it. A file path costs one write, ever — after that
 * every render passes a short string and the platform decodes off the JS
 * thread, with its own image cache underneath.
 *
 * SQLite stays the source of truth; this is a derived cache, so a cleared
 * cache directory is not a loss — `ensurePhotoUri` simply writes the file
 * again from the bytes it already has.
 */
const PHOTO_DIRECTORY = 'photos';

function photoFile(circleId: string, entryId: string): File {
  // The relay addresses a blob as (syncId, entryId); locally the same
  // pair is (circleId, entryId), so the name can't collide across circles.
  return new File(new Directory(Paths.cache, PHOTO_DIRECTORY), `${circleId}-${entryId}.jpg`);
}

/** Writes bytes to the cache, replacing whatever was there. Returns the `file://` URI. */
export function writePhotoFile(circleId: string, entryId: string, bytes: Uint8Array): string {
  const directory = new Directory(Paths.cache, PHOTO_DIRECTORY);
  directory.create({ intermediates: true, idempotent: true });

  const file = photoFile(circleId, entryId);
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}

/**
 * A circle's cover, which is cached exactly like a post photo — it sits at
 * the fixed `COVER_ENTRY_ID` the relay reserves for it, so it can't
 * collide with a post. These two wrappers exist so that key stays the
 * cache's business: every caller that has cover bytes (creating a circle,
 * joining one, an admin replacing it) just hands them over, and the circle
 * list asks for a path without knowing how covers are named.
 */
export function writeCoverFile(circleId: string, bytes: Uint8Array): string {
  return writePhotoFile(circleId, COVER_ENTRY_ID, bytes);
}

/** The cover's cached path, or null if it hasn't been written yet. */
export function cachedCoverUri(circleId: string): string | null {
  return ensurePhotoUri(circleId, COVER_ENTRY_ID, () => null);
}

/**
 * The cached file's URI, writing it from `readBytes()` only if it isn't
 * already there. `readBytes` is a callback rather than a value so a hit —
 * the overwhelmingly common case — never pulls the bytes out of SQLite
 * and across the bridge at all.
 */
export function ensurePhotoUri(
  circleId: string,
  entryId: string,
  readBytes: () => Uint8Array | null
): string | null {
  const file = photoFile(circleId, entryId);
  if (file.exists) return file.uri;

  const bytes = readBytes();
  if (!bytes) return null;

  return writePhotoFile(circleId, entryId, bytes);
}
