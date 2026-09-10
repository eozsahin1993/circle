import { Platform } from 'react-native';

/**
 * Android notification channels, one per circle — see
 * server/PUSH_DESIGN.md's "Channels and groups".
 *
 * A channel per circle is what gives Android its own per-circle sound,
 * vibration and mute in system settings, which is where people look for
 * them. They all sit under one group, so that screen reads as a "Circles"
 * heading with a row per circle. A group each would be a heading per circle
 * with a single meaningless channel beneath it; that only earns its place
 * once a circle has several channels to organise.
 *
 * No-ops everywhere but Android. iOS has no channel concept.
 */

const CIRCLES_GROUP_ID = 'circles';

/**
 * Required lazily, and never at module scope: `expo-notifications` binds a
 * native module, so a JS bundle running against a binary built before it
 * was added throws on *import* and takes the whole app down. A channel is
 * organisation, not correctness — it degrades to nothing.
 */
function notifications(): typeof import('expo-notifications') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications');
  } catch (err) {
    console.error('expo-notifications is missing from this build; skipping channel setup', err);
    return null;
  }
}

/**
 * Stable per circle, so a rename updates the row rather than leaving a
 * second one behind. Offering a tone picker *in the app* would force this
 * to carry the sound too, since a channel's sound is frozen once created
 * and only a new channel can change it — Android's own settings already
 * offer that per channel, so this stays simple until we don't.
 */
export function circleChannelId(circleId: string): string {
  return `circle-${circleId}`;
}

/**
 * Creates or updates a circle's channel. Safe to call repeatedly: the name
 * updates in place, which is how a renamed circle keeps a correct row.
 */
export async function ensureCircleChannel(circleId: string, circleName: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  const api = notifications();
  if (!api) return;

  await api.setNotificationChannelGroupAsync(CIRCLES_GROUP_ID, { name: 'Circles' });
  await api.setNotificationChannelAsync(circleChannelId(circleId), {
    name: circleName,
    groupId: CIRCLES_GROUP_ID,
    importance: api.AndroidImportance.DEFAULT,
  });
}

/**
 * Removes a circle's channel — leaving or deleting a circle. The group
 * stays: it is shared, and deleting it would take every other circle's
 * channel with it.
 */
export async function removeCircleChannel(circleId: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  const api = notifications();
  if (!api) return;

  await api.deleteNotificationChannelAsync(circleChannelId(circleId));
}
