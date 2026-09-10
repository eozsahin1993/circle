jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: jest.fn().mockResolvedValue(null),
  setNotificationChannelGroupAsync: jest.fn().mockResolvedValue(null),
  deleteNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  deleteNotificationChannelGroupAsync: jest.fn().mockResolvedValue(undefined),
}));

import {
  deleteNotificationChannelAsync,
  setNotificationChannelAsync,
  setNotificationChannelGroupAsync,
} from 'expo-notifications';
import { Platform } from 'react-native';

import { circleChannelId, ensureCircleChannel, removeCircleChannel } from '@/services/notification-channels';

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
});

/** One shared group, so settings reads as "Circles" with a row per circle. */
test('every circle is a channel under the one group', async () => {
  await ensureCircleChannel('circle-1', 'Family Circle');
  await ensureCircleChannel('circle-2', 'Book Club');

  expect(setNotificationChannelGroupAsync).toHaveBeenCalledWith('circles', { name: 'Circles' });
  expect((setNotificationChannelAsync as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
    'circle-circle-1',
    'circle-circle-2',
  ]);
  expect((setNotificationChannelAsync as jest.Mock).mock.calls[0][1]).toMatchObject({
    name: 'Family Circle',
    groupId: 'circles',
  });
});

/** A channel's name updates in place, so a rename must not leave a second row. */
test('renaming updates the same channel', async () => {
  await ensureCircleChannel('circle-1', 'Family Circle');
  await ensureCircleChannel('circle-1', 'Nana House');

  const calls = (setNotificationChannelAsync as jest.Mock).mock.calls;
  expect(calls.map((call) => call[0])).toEqual(['circle-circle-1', 'circle-circle-1']);
  expect(calls[1][1]).toMatchObject({ name: 'Nana House' });
});

/** The group is shared, so leaving must drop the channel and not the group. */
test('leaving removes only that circle channel', async () => {
  await removeCircleChannel('circle-1');

  expect(deleteNotificationChannelAsync).toHaveBeenCalledWith('circle-circle-1');
});

test('the channel id is stable per circle', () => {
  expect(circleChannelId('circle-1')).toBe('circle-circle-1');
});

test('does nothing on iOS, which has no channels', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });

  await ensureCircleChannel('circle-1', 'Family Circle');
  await removeCircleChannel('circle-1');

  expect(setNotificationChannelGroupAsync).not.toHaveBeenCalled();
  expect(deleteNotificationChannelAsync).not.toHaveBeenCalled();
});
