import { getPermissionsAsync } from 'expo-notifications';

import { getAllCircles } from '@/data/db';
import { circlePushPreferences } from '@/domain/usecases/push/push-preferences';
import { registerPushForCircle } from '@/domain/usecases/push/push-registration';
import { getDevicePushToken } from '@/services/push/tokens';

/**
 * Registers this device for every circle it can be reached in — call on
 * launch, and after joining or creating one.
 *
 * Re-running is the point rather than a cost: push tokens rotate, and the
 * fanout hash follows the circle's content key, so a rotation leaves a
 * stale registration that silently stops verifying. This is what heals it.
 *
 * Best-effort throughout. A refused permission, an offline relay or one
 * circle missing its key must not stop the others, and none of it should
 * ever surface as an error to whoever just opened the app.
 */
export async function enablePushEverywhere(): Promise<void> {
  // Never prompts: this runs on every launch, and the OS spends its one
  // prompt on whatever asks first.
  const device = await getDevicePushToken();
  if (!device) return;

  for (const circle of await getAllCircles()) {
    if (circle.pushSilenced) continue;

    try {
      const { categories } = await circlePushPreferences(circle.id);
      await registerPushForCircle(circle.id, { ...device, categories });
    } catch (err) {
      console.error(`Failed to enable notifications for circle ${circle.id}`, err);
    }
  }
}

/**
 * Asks for notification permission and registers one circle. Called from
 * the feed, which is the only place with that circle on screen to explain
 * what is being asked for — a usecase should not be popping OS dialogs.
 *
 * Returns immediately once permission has been answered either way, so
 * opening a feed costs nothing after the first time.
 */
export async function askForPushOnCircle(circleId: string): Promise<void> {
  // Granted means launch already registered this circle; denied means the
  // OS will not ask again.
  if ((await getPermissionsAsync()).status !== 'undetermined') return;

  const device = await getDevicePushToken({ ask: true });
  if (!device) return;

  const { categories } = await circlePushPreferences(circleId);
  await registerPushForCircle(circleId, { ...device, categories });
}
