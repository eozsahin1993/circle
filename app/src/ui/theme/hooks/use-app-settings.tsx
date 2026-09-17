import { useLocales } from 'expo-localization';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { useColorScheme } from '@/ui/theme/hooks/use-color-scheme';
import { applyLanguage, i18n } from '@/core/i18n/i18n';
import { showError } from '@/core/services/messages';
import { updateAppSettings, type AppSettings } from '@/core/services/settings';

export type AppSettingsContextValue = {
  settings: AppSettings;
  /** `settings.themePreference` resolved against the system scheme when it's 'system'. */
  scheme: 'light' | 'dark';
  /** Applies at once; resolves when the write has settled, whichever way it went. */
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
};

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

export type AppSettingsProviderProps = {
  /** Loaded once at startup — see _layout.tsx — so there's never a render with stale defaults. */
  initialSettings: AppSettings;
  children: ReactNode;
};

export function AppSettingsProvider({ initialSettings, children }: AppSettingsProviderProps) {
  const [settings, setSettings] = useState(initialSettings);
  const systemScheme = useColorScheme();
  const scheme = settings.themePreference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : settings.themePreference;
  const deviceLocales = useLocales();

  // Following the device means following it when it changes, too — Android
  // doesn't restart the app for that.
  useEffect(() => {
    applyLanguage(settings.language, deviceLocales);
  }, [settings.language, deviceLocales]);

  function updateSettings(patch: Partial<AppSettings>) {
    const before = settings;
    // Ahead of the state update, so no frame renders the new setting in the old language.
    if (patch.language) applyLanguage(patch.language, deviceLocales);
    setSettings((current) => ({ ...current, ...patch }));
    return updateAppSettings(patch).catch((error) => {
      console.error('Failed to save app settings', error);
      // Put it back rather than leave the switch showing a preference
      // that isn't stored — it would undo itself at the next launch,
      // which looks like the app forgetting rather than failing.
      if (patch.language) applyLanguage(before.language, deviceLocales);
      setSettings(before);
      showError(i18n.t('common.settingNotSaved'));
    });
  }

  return (
    <AppSettingsContext.Provider value={{ settings, scheme, updateSettings }}>
      {children}
    </AppSettingsContext.Provider>
  );
}

export function useAppSettings(): AppSettingsContextValue {
  const context = useContext(AppSettingsContext);
  if (!context) {
    throw new Error('useAppSettings must be used within an AppSettingsProvider');
  }
  return context;
}
