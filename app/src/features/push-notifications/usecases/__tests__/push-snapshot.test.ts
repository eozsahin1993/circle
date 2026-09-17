const mockFiles = new Map<string, string>();

jest.mock('expo-file-system', () => ({
  Paths: { appleSharedContainers: { 'group.com.eozsahin.mimoza': '/group' } },
  File: jest.fn().mockImplementation((dir: string, name: string) => {
    const path = `${dir}/${name}`;
    return {
      get exists() {
        return mockFiles.has(path);
      },
      write: (contents: string) => mockFiles.set(path, contents),
      delete: () => mockFiles.delete(path),
    };
  }),
}));
jest.mock('@/data/db', () => ({ getAllCircles: jest.fn(), getCircleMembers: jest.fn() }));

import { Platform } from 'react-native';

import { getAllCircles, getCircleMembers } from '@/data/db';
import { deleteAuthToken, saveAuthToken } from '@/core/services/keystore/auth-token';
import { clearPushSnapshot, refreshPushSnapshot } from '@/features/push-notifications/usecases/push-snapshot';

const SNAPSHOT = '/group/push-snapshot.json';

beforeAll(() => {
  jest.replaceProperty(Platform, 'OS', 'ios');
});

beforeEach(async () => {
  mockFiles.clear();
  (getAllCircles as jest.Mock).mockResolvedValue([{ id: 'circle-1', name: 'Family Circle' }]);
  (getCircleMembers as jest.Mock).mockResolvedValue([]);
  await saveAuthToken('session-token');
});

test('writes the snapshot while signed in', async () => {
  await refreshPushSnapshot();

  expect(JSON.parse(mockFiles.get(SNAPSHOT)!).circles[0].name).toBe('Family Circle');
});

test('writes nothing without a session', async () => {
  await deleteAuthToken();

  await refreshPushSnapshot();

  expect(mockFiles.has(SNAPSHOT)).toBe(false);
});

test('a refresh already reading when sign-out clears does not write the snapshot back', async () => {
  let releaseCircles!: () => void;
  (getAllCircles as jest.Mock).mockReturnValue(
    new Promise((resolve) => {
      releaseCircles = () => resolve([{ id: 'circle-1', name: 'Family Circle' }]);
    }),
  );

  const refresh = refreshPushSnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  await deleteAuthToken();
  await clearPushSnapshot();
  releaseCircles();
  await refresh;

  expect(mockFiles.has(SNAPSHOT)).toBe(false);
});
