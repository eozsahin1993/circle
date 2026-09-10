import { getAllCircles, getCircleMembers } from '@/data/db';
import { EntryTypes } from '@/domain/usecases/circle/log-entry';
import { verifyLogEntry } from '@/domain/usecases/circle/log-entry';
import { derivePushRoutingId } from '@/services/crypto';
import { getCircleKeyMap, getMasterSeed } from '@/services/keystore';

/**
 * Turning a delivered push into the words on the lock screen — see
 * server/PUSH_DESIGN.md.
 *
 * The relay forwards the entry's own ciphertext and cannot read it, so the
 * text is composed here, on the device, from keys the relay never has.
 */

/** The fixed string shown when nothing here could produce better. Names nothing. */
export const PUSH_PLACEHOLDER = 'New activity';

export type PushNotification = { circleId: string; channelId: string; title: string; body: string };

type PushData = { pushRoutingId?: string; payload?: string };

/**
 * Decrypts a push and writes its notification, or null if it cannot —
 * a forged push from someone without the circle's key, a circle this
 * device has since left, or an entry type it doesn't render.
 *
 * Null means "show nothing new". Android can honour that; iOS shows the
 * placeholder that travelled in the payload, since a delivered alert push
 * always produces a card.
 */
export async function handlePush(data: PushData): Promise<PushNotification | null> {
  const { pushRoutingId, payload } = data;
  if (!pushRoutingId || !payload) return null;

  const circle = await circleForRoutingId(pushRoutingId);
  if (!circle) return null;

  const keyMap = await getCircleKeyMap(circle.id);
  if (!keyMap) return null;

  // Every version, since the push doesn't name one. Cheap — a circle holds
  // a handful — and it avoids putting a plaintext key version on the wire.
  const ciphertext = new Uint8Array(Buffer.from(payload, 'base64'));
  for (const key of Object.values(keyMap)) {
    const envelope = verifyLogEntry(ciphertext, key);
    if (!envelope) continue;

    const body = await describeEntry(circle.id, envelope.type, envelope.authorPubkey);
    if (!body) return null;
    return { circleId: circle.id, channelId: `circle-${circle.id}`, title: circle.name, body };
  }
  return null;
}

/**
 * Matched by deriving, never by storing: a routing id is
 * `HKDF(seed, circleId)`, so this device can recompute its own and compare
 * without the relay ever having told it which circle is which.
 */
async function circleForRoutingId(pushRoutingId: string) {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) return null;

  return (
    (await getAllCircles()).find((circle) => derivePushRoutingId(masterSeed, circle.id) === pushRoutingId) ?? null
  );
}

/** Null for an entry type that shouldn't interrupt anyone. */
async function describeEntry(circleId: string, type: string, authorPubkey: string): Promise<string | null> {
  const name = await authorName(circleId, authorPubkey);

  switch (type) {
    case EntryTypes.POST:
      return `${name} added a photo`;
    case EntryTypes.COMMENT:
      return `${name} commented`;
    case EntryTypes.REACTION:
      return `${name} reacted to a photo`;
    case EntryTypes.MEMBER_ADDED:
      return `${name} joined`;
    default:
      return null;
  }
}

async function authorName(circleId: string, authorPubkey: string): Promise<string> {
  const member = (await getCircleMembers(circleId)).find(
    (candidate) => candidate.identityPublicKey === authorPubkey,
  );
  return member?.name || 'Someone';
}
