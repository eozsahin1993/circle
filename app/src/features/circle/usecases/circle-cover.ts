import { hashBytes } from '@/core/crypto/primitives';
import { getCircleCoverBytes, getCircleCoverHash, getNewestFetchedPostId, updateCirclePicture } from '@/data/db';
import { cachedCoverUri, ensurePhotoUri, writeCoverFile } from '@/core/photo/photo-cache';

/**
 * The circle's image as a cached `file://` path. A circle's cover always
 * caches to the same fixed path family (see photo-cache.ts's
 * COVER_ENTRY_ID) suffixed with its own hash, so a changed cover gets a
 * genuinely different path — otherwise this cache's own "does it exist"
 * check, and `expo-image`'s native cache on top of it, would both keep
 * showing whatever was cached under the old cover's path forever.
 *
 * Only a circle whose file is missing under its current hash costs a
 * read of its bytes; everything else is an existence check — which is
 * what keeps re-entering a screen cheap. Handing `expo-image` a base64
 * data URI instead meant serialising ~260KB of string into the native
 * tree on every focus.
 *
 * Shared so the circle list and the details screen can't show a circle two
 * different faces.
 */
export async function resolveCircleCoverUri(circleId: string): Promise<string | undefined> {
  const hash = await getCircleCoverHash(circleId);
  if (hash) {
    const cached = cachedCoverUri(circleId, hash);
    if (cached) return cached;
  }

  const bytes = await getCircleCoverBytes(circleId);
  if (bytes) {
    // A cover stored before picture_hash existed has none, and SQLite can't
    // compute SHA-256 in migration 0017 — backfill it on first read.
    if (hash) return writeCoverFile(circleId, bytes, hash);
    const backfilled = hashBytes(bytes);
    await updateCirclePicture(circleId, bytes, backfilled);
    return writeCoverFile(circleId, bytes, backfilled);
  }

  // No cover of its own: fall back to the newest post's photo, reusing the
  // file the photo queue already wrote rather than reading those bytes
  // back out of SQLite. Deliberately not cached under COVER_ENTRY_ID — the
  // fallback should follow the newest post, not freeze on today's.
  const newestPostId = await getNewestFetchedPostId(circleId);
  return newestPostId ? (ensurePhotoUri(circleId, newestPostId, () => null) ?? undefined) : undefined;
}
