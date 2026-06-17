export type NativeThemeSource = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'overlord-theme';

function readStoredTheme(): NativeThemeSource {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // localStorage may be unavailable in rare embed contexts.
  }
  return 'dark';
}

/** Push the SPA theme to the desktop shell so macOS vibrancy respects dark mode. */
export function syncDesktopNativeTheme(theme?: NativeThemeSource): void {
  const bridge = typeof window === 'undefined' ? undefined : window.overlord;
  if (!bridge?.setNativeThemeSource) return;

  void bridge.setNativeThemeSource(theme ?? readStoredTheme());
}
