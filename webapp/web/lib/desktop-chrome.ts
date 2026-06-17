import type { CSSProperties } from 'react';

/**
 * Desktop-shell chrome detection. The SPA stays a normal web app and only
 * *feature-detects* the Electron shell via the `window.overlord` preload bridge
 * — it never depends on it. Inside the macOS shell the native title bar is
 * removed (`hiddenInset`) and the traffic lights are inset over the content, so
 * the top strip must be draggable and the sidebar header must reserve room for
 * the lights. In a browser everything below is inert (`-webkit-app-region` has
 * no effect and the flags are all `false`).
 */
export type DesktopChrome = {
  /** Running inside the Electron desktop shell. */
  isDesktop: boolean;
  /** Inside the shell on macOS, where inset traffic lights overlay the chrome. */
  isMacDesktop: boolean;
};

export function getDesktopChrome(): DesktopChrome {
  const bridge = typeof window === 'undefined' ? undefined : window.overlord;
  const isDesktop = bridge?.isDesktop === true;
  return {
    isDesktop,
    isMacDesktop: isDesktop && bridge?.platform === 'darwin'
  };
}

/** Marks an element as the OS window-drag region inside the shell. */
export const DRAG_REGION: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties;

/** Opts an interactive element out of the surrounding drag region. */
export const NO_DRAG_REGION: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties;
