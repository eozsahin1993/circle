import { getAllCircles } from '@/data/db';
import {
  categoriesFromMask,
  circlePushPreferences,
} from '@/domain/usecases/push/push-preferences';
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

/** Registers one circle, for the moment right after joining or creating it. */
export async function enablePushForCircle(circleId: string, categoryMask: number): Promise<void> {
  const device = await getDevicePushToken();
  if (!device) return;

  await registerPushForCircle(circleId, { ...device, categories: categoriesFromMask(categoryMask) });
}
