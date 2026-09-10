import {
  AndroidImportance,
  deleteNotificationChannelAsync,
  setNotificationChannelAsync,
  setNotificationChannelGroupAsync,
} from 'expo-notifications';
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

  await setNotificationChannelGroupAsync(CIRCLES_GROUP_ID, { name: 'Circles' });
  await setNotificationChannelAsync(circleChannelId(circleId), {
    name: circleName,
    groupId: CIRCLES_GROUP_ID,
    importance: AndroidImportance.DEFAULT,
  });
}

/**
 * Removes a circle's channel — leaving or deleting a circle. The group
 * stays: it is shared, and deleting it would take every other circle's
 * channel with it.
 */
export async function removeCircleChannel(circleId: string): Promise<void> {
  if (Platform.OS !== 'android') return;

  await deleteNotificationChannelAsync(circleChannelId(circleId));
}
