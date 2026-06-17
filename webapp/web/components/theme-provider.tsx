import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import { type ReactNode, useEffect } from 'react';

import { syncDesktopNativeTheme } from '@/lib/desktop-native-theme';

function DesktopNativeThemeSync() {
  const { theme } = useTheme();

  useEffect(() => {
    if (!theme) return;
    syncDesktopNativeTheme(theme as 'light' | 'dark' | 'system');
  }, [theme]);

  return null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      storageKey="overlord-theme"
      disableTransitionOnChange
    >
      <DesktopNativeThemeSync />
      {children}
    </NextThemesProvider>
  );
}
