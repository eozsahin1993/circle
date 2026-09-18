import Constants from 'expo-constants';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/ui/theme/themed-text';

/** Set by app.config.js; absent in tests and in a bare `expo start`. */
const APP_ENV = (Constants.expoConfig?.extra as { appEnv?: string } | undefined)?.appEnv;

/**
 * Names the environment on screen whenever it isn't production.
 *
 * Staging is a separate app with its own icon and name, but neither is
 * visible once it's open — and a staging build talking to the staging
 * relay looks exactly like the real thing, right up until someone reports
 * a bug against data that was never real.
 *
 * Deliberately unmissable rather than tasteful, and `pointerEvents="none"`
 * so it can never swallow a tap meant for the screen underneath.
 */
export function EnvBadge() {
  if (!APP_ENV || APP_ENV === 'production') return null;

  return (
    <View style={styles.badge} pointerEvents="none">
      <ThemedText type="meta" style={styles.label}>
        {APP_ENV.toUpperCase()}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    // Below the status bar, above everything the app draws.
    top: 0,
    right: 0,
    paddingTop: 54,
    paddingBottom: 4,
    paddingHorizontal: 10,
    borderBottomLeftRadius: 10,
    backgroundColor: 'rgba(217,122,110,0.92)',
  },
  label: {
    color: '#17120C',
    letterSpacing: 1,
  },
});
