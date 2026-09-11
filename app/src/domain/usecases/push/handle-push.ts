import { bytesToHex } from '@noble/curves/utils.js';

import { getAllCircles, getCircleMembers } from '@/data/db';
import { EntryTypes } from '@/domain/usecases/circle/log-entry';
import { verifyLogEntry, type LogEntryEnvelope } from '@/domain/usecases/circle/log-entry';
import { derivePushRoutingId } from '@/services/crypto';
import { getCircleIdentity, getCircleKeyMap, getMasterSeed } from '@/services/keystore';
import { circleNotificationChannelId } from '@/services/push/channels';

/**
 * Turning a delivered push into the words on the lock screen.
 *
 * The relay forwards the entry's own ciphertext and cannot read it, so the
 * text is composed here, on the device, from keys the relay never has.
 */

/** The fixed string shown when nothing here could produce better. Names nothing. */
export const PUSH_PLACEHOLDER = 'New activity';

export type PushNotification = { circleId: string; channelId: string; title: string; body: string };

/** keyVersion is a string in FCM data messages, a number in APNs userInfo. */
export type PushData = { pushRoutingId?: string; keyVersion?: string | number; payload?: string };

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
  if (!data.pushRoutingId) return null;

  const circle = await circleForRoutingId(data.pushRoutingId);
  if (!circle) return null;

  const envelope = await decryptPushEntry(circle.id, data);
  if (!envelope) return null;

  const body = await describeEntry(circle.id, envelope);
  if (!body) return null;
  return { circleId: circle.id, channelId: circleNotificationChannelId(circle.id), title: circle.name, body };
}

/**
 * Matched by deriving, never by storing: a routing id is
 * `HKDF(seed, circleId)`, so this device can recompute its own and compare
 * without the relay ever having told it which circle is which.
 */
export async function circleForRoutingId(pushRoutingId: string) {
  const masterSeed = await getMasterSeed();
  if (!masterSeed) return null;

  return (
    (await getAllCircles()).find((circle) => derivePushRoutingId(masterSeed, circle.id) === pushRoutingId) ?? null
  );
}

/** The decrypted, verified envelope a push carries — shared by the notification text (above) and tap routing (push-destination.ts). */
export async function decryptPushEntry(circleId: string, data: PushData): Promise<LogEntryEnvelope | null> {
  if (!data.payload) return null;

  const keyMap = await getCircleKeyMap(circleId);
  if (!keyMap) return null;

  // The push names its version, so this is one decrypt rather than one per
  // version held. A version this device doesn't have means an entry it was
  // never meant to read.
  const key = keyMap[Number(data.keyVersion)];
  if (!key) return null;

  return verifyLogEntry(new Uint8Array(Buffer.from(data.payload, 'base64')), key);
}

/** Null for an entry type that shouldn't interrupt anyone. */
async function describeEntry(circleId: string, envelope: LogEntryEnvelope): Promise<string | null> {
  // `member_added` is signed by the admin who approved it, not by the
  // person joining, so the author is the wrong name here. It carries the
  // joiner's own — which is also the only name available, since this
  // arrives before the sync that would put them on the roster.
  if (envelope.type === EntryTypes.MEMBER_ADDED) {
    const joined = (envelope.payload as { name?: unknown })?.name;
    return `${typeof joined === 'string' && joined ? joined : 'Someone'} joined`;
  }

  const name = await authorName(circleId, envelope.authorPubkey);
  switch (envelope.type) {
    case EntryTypes.POST:
      return `${name} added a photo`;
    case EntryTypes.COMMENT: {
      const record = envelope.payload as { body?: unknown; postAuthorPubkey?: unknown } | undefined;
      const text = typeof record?.body === 'string' && record.body ? `: “${record.body}”` : '';
      const postAuthor = record?.postAuthorPubkey;
      if (typeof postAuthor !== 'string') return `${name} commented${text}`;

      const own = (await getCircleIdentity(circleId))?.publicKey;
      return own && bytesToHex(own) === postAuthor
        ? `${name} commented on your photo${text}`
        : `${name} also commented${text}`;
    }
    case EntryTypes.REACTION: {
      // Every reaction push is already scoped to the post's own author (see
      // notify-circle.ts), so "your photo" is always literally true here.
      const emoji = (envelope.payload as { emoji?: unknown })?.emoji;
      return typeof emoji === 'string' && emoji ? `${name} reacted ${emoji} to your photo` : `${name} reacted to your photo`;
    }
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
