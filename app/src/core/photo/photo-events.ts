/**
 * Photos land on their own queue after screens have already read the
 * database once on focus. The queue pings here per fetched photo, and
 * subscribers patch just that post rather than reloading — a backlog
 * landing one by one must not mean a feed reload apiece.
 */

export type PhotoFetched = { circleId: string; postId: string; uri: string };

type Listener = (event: PhotoFetched) => void;

const listeners = new Set<Listener>();

/** Returns the unsubscribe. */
export function onPhotoFetched(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyPhotoFetched(event: PhotoFetched): void {
  listeners.forEach((listener) => listener(event));
}
