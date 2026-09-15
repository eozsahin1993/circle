/**
 * The iOS App Group shared by the app and the notification service
 * extension — one identifier for both the shared Keychain access group
 * (core/services/keystore/store.ts) and the shared container
 * (usecases/push-snapshot.ts). Must match the entitlements in app.json and
 * targets/notification-service.
 */
export const APP_GROUP = 'group.com.eozsahin.circle';
