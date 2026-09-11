/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'notification-service',
  name: 'CircleNotificationService',
  bundleIdentifier: '.notification-service',
  // Matches the app's own deployment target (Expo SDK 57 default).
  deploymentTarget: '15.1',
  frameworks: ['UserNotifications'],
  entitlements: {
    // Same group as the main app (see app.json) — it doubles as the shared
    // Keychain access group (keystore.ts) and the snapshot container
    // (push-snapshot.ts).
    'com.apple.security.application-groups': config.ios.entitlements['com.apple.security.application-groups'],
  },
});
