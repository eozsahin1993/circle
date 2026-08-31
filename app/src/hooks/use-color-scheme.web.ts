import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web.
 * `useSyncExternalStore`'s server-snapshot argument handles that mismatch directly, instead of
 * rendering a default then flipping to the real value in an effect after mount.
 */
function subscribe(callback: () => void) {
  const subscription = Appearance.addChangeListener(callback);
  return () => subscription.remove();
}

function getSnapshot() {
  return Appearance.getColorScheme();
}

function getServerSnapshot() {
  return 'light';
}

export function useColorScheme() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
