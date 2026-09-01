import { createContext, useContext, useState, type ReactNode } from 'react';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { updateAppSettings, type AppSettings } from '@/services/settings';

export type AppSettingsContextValue = {
  settings: AppSettings;
  /** `settings.themePreference` resolved against the system scheme when it's 'system'. */
  scheme: 'light' | 'dark';
  updateSettings: (patch: Partial<AppSettings>) => void;
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

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
    updateAppSettings(patch).catch((error) => console.error('Failed to save app settings', error));
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
