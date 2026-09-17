jest.mock('@react-native-google-signin/google-signin', () => ({}));
jest.mock('expo-apple-authentication', () => ({}));
jest.mock('@/features/account/services/auth-relay');
jest.mock('@/features/push-notifications/usecases/enable-push');
jest.mock('@/features/push-notifications/usecases/push-snapshot');

import { getAuthToken, saveAuthToken } from '@/core/services/keystore/auth-token';
import { logout } from '@/features/account/services/auth-relay';
import { signOut } from '@/features/account/usecases/sign-in';
import { unregisterPushEverywhere } from '@/features/push-notifications/usecases/enable-push';
import { clearPushSnapshot } from '@/features/push-notifications/usecases/push-snapshot';

beforeEach(async () => {
  jest.clearAllMocks();
  (logout as jest.Mock).mockResolvedValue(undefined);
  (unregisterPushEverywhere as jest.Mock).mockResolvedValue(undefined);
  (clearPushSnapshot as jest.Mock).mockResolvedValue(undefined);
  await saveAuthToken('session-token');
});

test('unregisters push while the session is still valid, then revokes it', async () => {
  const order: string[] = [];
  (unregisterPushEverywhere as jest.Mock).mockImplementation(async () => {
    order.push(`unregister:${await getAuthToken()}`);
  });
  (logout as jest.Mock).mockImplementation(async () => order.push('logout'));
  (clearPushSnapshot as jest.Mock).mockImplementation(async () => {
    order.push(`clear:${await getAuthToken()}`);
  });

  await signOut();

  expect(order).toEqual(['unregister:session-token', 'logout', 'clear:null']);
});

test('still signs out when push cleanup throws', async () => {
  (unregisterPushEverywhere as jest.Mock).mockRejectedValue(new Error('database closed'));
  jest.spyOn(console, 'error').mockImplementation(() => {});

  await signOut();

  expect(logout).toHaveBeenCalledWith('session-token');
  expect(await getAuthToken()).toBeNull();
  expect(clearPushSnapshot).toHaveBeenCalled();
});
