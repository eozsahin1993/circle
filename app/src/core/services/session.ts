import { deleteAuthToken } from '@/core/services/keystore/auth-token';

/**
 * The relay disowning this device's session — a 401 from any
 * authenticated call.
 *
 * A one-way push for the same reason `messages.ts` is one: what finds out
 * is usually a background sync pass, which has no component to tell.
 *
 * Not a rare path. Sessions last 90 days (the relay's `auth.TTL`) and
 * nothing renews them, so every device still installed by then lands
 * here — until that's addressed, this is the only thing standing between
 * a long-lived install and an app that silently stops syncing.
 */

type Listener = () => void;

/** Exactly one host is mounted — see `useSessionExpiry`. */
let listener: Listener | null = null;

/** Called by the host as it mounts, and with null as it unmounts. */
export function setSessionExpiredListener(next: Listener | null): void {
  listener = next;
}

/**
 * Drops the dead token and says so, once, however many in-flight requests
 * come back 401 together — a sync pass fans out across circles, so they
 * arrive in a burst rather than one at a time.
 *
 * Deliberately not `signOut`: unregistering push and revoking the session
 * relay-side both need the session this no longer has, so both would 401
 * their way straight back here.
 */
export function noteSessionExpired(): Promise<void> {
  inFlight ??= expire().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

let inFlight: Promise<void> | null = null;

async function expire(): Promise<void> {
  await deleteAuthToken();
  listener?.();
}
