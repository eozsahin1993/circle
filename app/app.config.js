const GOOGLE_SIGN_IN = '@react-native-google-signin/google-signin';

/**
 * Derives Google Sign-In's iOS URL scheme from the same client ID the app
 * passes to GoogleSignin.configure(), so the two can't drift. The SDK refuses
 * to sign in when the scheme isn't that ID reversed.
 */
function iosUrlScheme() {
  const clientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const suffix = '.apps.googleusercontent.com';
  if (!clientId?.endsWith(suffix)) return undefined;
  return `com.googleusercontent.apps.${clientId.slice(0, -suffix.length)}`;
}

/**
 * Staging is a separate app, not a flag inside one: its own bundle id,
 * name, scheme and App Group, so both can be installed side by side.
 *
 * The App Group is the part that matters most. It backs the shared
 * Keychain (keystore.ts) and the notification extension's snapshot
 * (push-snapshot.ts), so one group across both apps would mean staging
 * reading prod's master seed and circles.
 *
 * APNs topics are bundle ids, and Google/Apple OAuth clients are tied to
 * them too, so an environment's relay config has to match this — see
 * server/.env.example and docs/INFRASTRUCTURE.md.
 */
const ENVIRONMENTS = {
  local: {},
  production: {},
  staging: {
    nameSuffix: ' (Staging)',
    idSuffix: '.staging',
    scheme: 'mimoza-staging',
  },
};

module.exports = ({ config }) => {
  const name = process.env.APP_ENV || 'local';
  const env = ENVIRONMENTS[name];
  if (!env) {
    throw new Error(`APP_ENV=${name} is not an environment (${Object.keys(ENVIRONMENTS).join(', ')})`);
  }
  if (!env.idSuffix) return withGoogleScheme(withEnv(config, name));

  const bundleIdentifier = `${config.ios.bundleIdentifier}${env.idSuffix}`;
  const appGroup = `group.${bundleIdentifier}`;

  return withGoogleScheme(withEnv({
    ...config,
    name: `${config.name}${env.nameSuffix}`,
    scheme: env.scheme,
    ios: {
      ...config.ios,
      bundleIdentifier,
      entitlements: {
        ...config.ios.entitlements,
        'com.apple.security.application-groups': [appGroup],
      },
    },
    android: {
      ...config.android,
      package: `${config.android.package}${env.idSuffix}`,
      // One file per environment, so a build can only ever carry the
      // Firebase config it is meant to — a shared file works (the SDK
      // picks the client matching the running package) but ships both.
      googleServicesFile: './google-services.staging.json',
    },
  }, name));
};

// Readable at runtime through Constants.expoConfig.extra, so the app can
// say which environment it is — see ui/components/env-badge.tsx. A build
// that reaches the wrong relay is otherwise indistinguishable on screen.
function withEnv(config, name) {
  return { ...config, extra: { ...config.extra, appEnv: name } };
}

function withGoogleScheme(config) {
  return {
    ...config,
    plugins: config.plugins.map((plugin) =>
      plugin === GOOGLE_SIGN_IN ? [GOOGLE_SIGN_IN, { iosUrlScheme: iosUrlScheme() }] : plugin,
    ),
  };
}
