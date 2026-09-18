import Constants from 'expo-constants';

/**
 * The iOS App Group shared by the app and the notification service
 * extension — one identifier for both the shared Keychain access group
 * (core/services/keystore/store.ts) and the shared container
 * (usecases/push-snapshot.ts). Must match the entitlements in app.json and
 * targets/notification-service.
 *
 * Read from the resolved config rather than written here: it carries the
 * bundle id, which differs per environment (app.config.js). The literal is
 * the fallback for contexts with no config, such as tests.
 */
export const APP_GROUP =
  Constants.expoConfig?.ios?.entitlements?.['com.apple.security.application-groups']?.[0] ??
  'group.com.eozsahin.mimoza';
