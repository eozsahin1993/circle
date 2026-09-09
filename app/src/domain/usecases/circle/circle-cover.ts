import { getCircleCoverBytes, getNewestFetchedPostId } from '@/data/db';
import { cachedCoverUri, ensurePhotoUri, writeCoverFile } from '@/services/photo-cache';

/**
 * The circle's image as a cached `file://` path. Only a circle whose file
 * is missing costs a read of its bytes; everything after is an existence
 * check — which is what keeps re-entering a screen cheap. Handing
 * `expo-image` a base64 data URI instead meant serialising ~260KB of
 * string into the native tree on every focus.
 *
 * Shared so the circle list and the details screen can't show a circle two
 * different faces.
 */
export async function resolveCircleCoverUri(circleId: string): Promise<string | undefined> {
  const cached = cachedCoverUri(circleId);
  if (cached) return cached;

  const bytes = await getCircleCoverBytes(circleId);
  if (bytes) return writeCoverFile(circleId, bytes);

  // No cover of its own: fall back to the newest post's photo, reusing the
  // file the photo queue already wrote rather than reading those bytes
  // back out of SQLite. Deliberately not cached under COVER_ENTRY_ID — the
  // fallback should follow the newest post, not freeze on today's.
  const newestPostId = await getNewestFetchedPostId(circleId);
  return newestPostId ? (ensurePhotoUri(circleId, newestPostId, () => null) ?? undefined) : undefined;
}
