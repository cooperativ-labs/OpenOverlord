import { contextBridge, ipcRenderer } from 'electron';

/**
 * The `window.overlord` bridge. Kept deliberately tiny: a few shell-only
 * affordances the unmodified SPA can *feature-detect* (`if (window.overlord)`),
 * never depend on. No tokens, no Node, no product logic crosses this boundary.
 */
const api = {
  /** Marks that the SPA is running inside the desktop shell. */
  isDesktop: true as const,
  platform: process.platform,
  version: process.env.OVERLORD_DESKTOP_VERSION ?? null,
  /** Open the native directory picker; resolves to an absolute path or null. */
  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('overlord:choose-directory'),
  /** Open an http(s) URL in the system browser. */
  openExternal: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('overlord:open-external', url),
  /** Reveal a path in the OS file manager. */
  revealInFinder: (path: string): Promise<boolean> => ipcRenderer.invoke('overlord:reveal', path)
};

export type OverlordBridge = typeof api;

contextBridge.exposeInMainWorld('overlord', api);
