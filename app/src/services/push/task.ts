import {
  registerTaskAsync,
  scheduleNotificationAsync,
  setNotificationHandler,
  type NotificationTaskPayload,
} from 'expo-notifications';
import { defineTask } from 'expo-task-manager';
import { Platform } from 'react-native';

import { handlePush } from '@/domain/usecases/push/handle-push';
import { initDatabase } from '@/data/db';

/**
 * The background handler that turns a delivered push into a notification —
 * see server/PUSH_DESIGN.md.
 *
 * Must be defined at module scope in a module loaded early: the task
 * manager loads the JS bundle on its own to run this, with no screen
 * mounted and no app state, so anything it needs has to be reachable from
 * here.
 */

const PUSH_TASK = 'circle-push';

defineTask<NotificationTaskPayload>(PUSH_TASK, async ({ data, error }) => {
  if (error) {
    console.error('Push task failed', error);
    return;
  }

  try {
    // The bundle may have been started by this task alone, so nothing has
    // opened the database yet. Idempotent, and memoized (see run.ts).
    await initDatabase();

    const notification = await handlePush(pushDataFrom(data));
    // Null means nothing worth interrupting for — a push we couldn't
    // decrypt, or an entry type that shouldn't raise a card. Showing
    // nothing is the right answer, and on Android we can.
    if (!notification) return;

    await scheduleNotificationAsync({
      content: { title: notification.title, body: notification.body },
      trigger: { channelId: notification.channelId },
    });
  } catch (err) {
    console.error('Failed to handle a push', err);
  }
});

/**
 * FCM data values arrive as strings, but the shape differs between a
 * delivered notification and a response to one being tapped.
 */
function pushDataFrom(data: unknown): { pushRoutingId?: string; keyVersion?: string; payload?: string } {
  const record = (data ?? {}) as Record<string, unknown>;
  const body = (record.data ?? record) as Record<string, unknown>;
  return {
    pushRoutingId: typeof body.pushRoutingId === 'string' ? body.pushRoutingId : undefined,
    keyVersion: typeof body.keyVersion === 'string' ? body.keyVersion : undefined,
    payload: typeof body.payload === 'string' ? body.payload : undefined,
  };
}

/**
 * Registers the task and how a notification behaves while the app is open.
 *
 * Separate from the `defineTask` above because that has to run at import
 * and this is async — the module's import is what the task manager needs
 * to find, not this call.
 */
export async function startPushHandling(): Promise<void> {
  setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  // Android only for now. The relay sends nothing to iOS — those go direct
  // to APNs, which isn't built — so registering there would fail every
  // launch on a build without the remote-notification entitlement, for a
  // task that has nothing to receive. Lift this with the iOS extension.
  if (Platform.OS !== 'android') return;

  await registerTaskAsync(PUSH_TASK);
}
