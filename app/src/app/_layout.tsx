import 'react-native-get-random-values';

import { Figtree_400Regular, Figtree_500Medium, Figtree_600SemiBold } from '@expo-google-fonts/figtree';
import { Newsreader_300Light, Newsreader_400Regular, Newsreader_500Medium } from '@expo-google-fonts/newsreader';
import { Buffer } from 'buffer';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useFonts } from 'expo-font';
import { useEffect, useState } from 'react';
import * as SplashScreen from 'expo-splash-screen';

import { Colors } from '@/constants/theme';
import { initDatabase } from '@/data/db';
import { AppSettingsProvider, useAppSettings } from '@/hooks/use-app-settings';
import { getAppSettings, type AppSettings } from '@/services/settings';

// drizzle-orm's default sqlite blob column (posts.photo, circleMembers.picture,
// deviceProfile.picture) calls the global `Buffer` directly with no existence
// check — present in Node/Jest, absent from Hermes on-device, so every blob
// read/write throws `ReferenceError: Property 'Buffer' doesn't exist` without
// this polyfill.
global.Buffer = global.Buffer ?? Buffer;

SplashScreen.preventAutoHideAsync();

const HearthDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: Colors.dark.background,
    card: Colors.dark.surface,
    text: Colors.dark.text,
    primary: Colors.dark.accent,
    border: Colors.dark.faintest,
  },
};

const HearthLightTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: Colors.light.background,
    card: Colors.light.surface,
    text: Colors.light.text,
    primary: Colors.light.accent,
    border: Colors.light.muted,
  },
};

/** Picks the nav theme off the resolved scheme (system/light/dark preference already applied) rather than the raw OS setting, so the Appearance picker in /account actually changes anything. */
function AppShell() {
  const { scheme } = useAppSettings();

  return (
    <ThemeProvider value={scheme === 'dark' ? HearthDarkTheme : HearthLightTheme}>
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Newsreader_300Light,
    Newsreader_400Regular,
    Newsreader_500Medium,
    Figtree_400Regular,
    Figtree_500Medium,
    Figtree_600SemiBold,
  });
  const [dbReady, setDbReady] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    initDatabase()
      .then(() => setDbReady(true))
      .catch((error) => console.error('Failed to initialize database', error));
    getAppSettings()
      .then(setSettings)
      .catch((error) => console.error('Failed to load app settings', error));
  }, []);

  useEffect(() => {
    if (fontsLoaded && dbReady && settings) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, dbReady, settings]);

  if (!fontsLoaded || !dbReady || !settings) {
    return null;
  }

  return (
    <AppSettingsProvider initialSettings={settings}>
      <AppShell />
    </AppSettingsProvider>
  );
}
