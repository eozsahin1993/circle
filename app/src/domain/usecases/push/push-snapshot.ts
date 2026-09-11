import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { getAllCircles, getCircleMembers } from '@/data/db';
import { APP_GROUP } from '@/services/app-group';

export const PUSH_SNAPSHOT_FILE = 'push-snapshot.json';

/**
 * Mirrors the circle and member names the iOS notification extension
 * needs into the App Group container — it can't open the app's SQLite.
 * Stale is benign (a card says "Someone"); never throws, since the sync
 * and launch paths calling it must not fail on it.
 */
export async function refreshPushSnapshot(): Promise<void> {
  if (Platform.OS !== 'ios') return;

  try {
    const container = Paths.appleSharedContainers?.[APP_GROUP];
    if (!container) return;

    const circles = [];
    for (const circle of await getAllCircles()) {
      const members = await getCircleMembers(circle.id);
      circles.push({
        id: circle.id,
        name: circle.name,
        members: members.map((member) => ({ identityPublicKey: member.identityPublicKey, name: member.name })),
      });
    }

    new File(container, PUSH_SNAPSHOT_FILE).write(JSON.stringify({ circles }));
  } catch (err) {
    console.error('Failed to write the push snapshot', err);
  }
}
