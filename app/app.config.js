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

module.exports = ({ config }) => ({
  ...config,
  plugins: config.plugins.map((plugin) =>
    plugin === GOOGLE_SIGN_IN ? [GOOGLE_SIGN_IN, { iosUrlScheme: iosUrlScheme() }] : plugin,
  ),
});
