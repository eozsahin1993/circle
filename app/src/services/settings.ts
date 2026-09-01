import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemePreference = 'system' | 'light' | 'dark';

export type AppSettings = {
  themePreference: ThemePreference;
  notifyNewPhotos: boolean;
  notifyCommentsReactions: boolean;
  notifyMemberJoined: boolean;
};

const STORAGE_KEY = 'app_settings';

const DEFAULT_SETTINGS: AppSettings = {
  themePreference: 'system',
  notifyNewPhotos: true,
  notifyCommentsReactions: true,
  notifyMemberJoined: false,
};

/**
 * Device-local UI preferences (appearance, notification toggles) — not
 * circle data, so this lives in shared prefs / UserDefaults via
 * AsyncStorage rather than a SQLite table. Nothing here needs to be
 * queried or joined, just read whole and written back whole.
 */
export async function getAppSettings(): Promise<AppSettings> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
  const current = await getAppSettings();
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
}
