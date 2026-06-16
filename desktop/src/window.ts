import { BrowserWindow, type Session, shell } from 'electron';
import path from 'node:path';

/**
 * Creates the single hardened BrowserWindow. The security baseline
 * (`contextIsolation`, `sandbox`, `nodeIntegration: false`, a `preload` exposed
 * via `contextBridge`) is non-negotiable: the renderer is the unmodified webapp
 * SPA loaded over a loopback origin and must never get Node access.
 */
export function createWindow(preloadPath: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0b0b0f',
    show: false,
    title: 'Overlord',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true
    }
  });

  window.once('ready-to-show', () => window.show());
  return window;
}

/**
 * Apply a loopback-scoped Content-Security-Policy to every response. Far simpler
 * than the closed app's CSP because there is no remote/Supabase origin: the
 * renderer and API share one `http://<host>:<port>` origin, so `'self'` already
 * covers the SPA's fetches and the SSE stream. We allow inline styles (the SPA's
 * theming injects them) and `data:`/`blob:` images/fonts.
 */
export function applyCsp(session: Session, appOrigin: string): void {
  const wsOrigin = appOrigin.replace(/^http/, 'ws');
  const csp = [
    `default-src 'self'`,
    // The SPA's index.html carries one tiny inline theme-bootstrap script; allow
    // exactly that one by hash rather than opening up 'unsafe-inline'. Keep this
    // hash in sync if that snippet ever changes.
    `script-src 'self' 'sha256-Y0NzcdWqLK5zUKdExAf8aq3UxpIzkXbzq9budSiMuvc='`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${appOrigin} ${wsOrigin}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`
  ].join('; ');

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    });
  });
}

/**
 * Keep in-app navigation on the loopback origin and push everything else
 * (docs links, GitHub, external auth) to the system browser. Origin comparison
 * only — identical to the closed app's handlers.
 */
export function guardNavigation(window: BrowserWindow, appOrigin: string): void {
  const isExternal = (target: string): boolean => {
    try {
      return new URL(target).origin !== appOrigin;
    } catch {
      return true;
    }
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url)) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isExternal(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

export function splashPath(distElectronDir: string): string {
  return path.join(distElectronDir, 'splash.html');
}
