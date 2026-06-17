import { nativeTheme } from 'electron';

export type NativeThemeSource = 'light' | 'dark' | 'system';

export function isNativeThemeSource(value: unknown): value is NativeThemeSource {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Mirror the SPA theme so macOS window vibrancy follows light/dark mode. */
export function setNativeThemeSource(source: NativeThemeSource): void {
  nativeTheme.themeSource = source;
}
