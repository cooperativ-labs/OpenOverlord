import {
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  type Session,
  shell
} from 'electron';
import path from 'node:path';

const isMac = process.platform === 'darwin';

/**
 * Creates the single hardened BrowserWindow. The security baseline
 * (`contextIsolation`, `sandbox`, `nodeIntegration: false`, a `preload` exposed
 * via `contextBridge`) is non-negotiable: the renderer is the unmodified webapp
 * SPA loaded over a loopback origin and must never get Node access.
 *
 * On macOS the native title bar is removed (`hiddenInset`) and the traffic
 * lights are inset into the content so the webapp's own top nav serves as the
 * title bar — there is no separate "Overlord" chrome above the UI. The webapp
 * feature-detects the shell (`window.overlord`) to make that strip draggable and
 * to reserve space for the inset traffic lights.
 *
 * macOS also uses `vibrancy: 'sidebar'` with a transparent window background so
 * the SPA's translucent sidebar column shows the native sidebar material. Main
 * content stays opaque via `bg-background` in the renderer. The SPA syncs
 * `nativeTheme.themeSource` via IPC so vibrancy follows the app's theme toggle.
 */
export function createWindow({
  preloadPath,
  partition
}: {
  preloadPath: string;
  partition?: string;
}): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: isMac ? '#00000000' : '#0b0b0f',
    show: false,
    title: 'Overlord',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 14 },
          vibrancy: 'sidebar' as const
        }
      : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
      partition
    }
  });

  registerNativeContextMenu(window);
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    const message = [
      '<!doctype html>',
      '<html><body style="margin:0;background:#0b0b0f;color:#f4f4f5;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;min-height:100vh;place-items:center;">',
      '<main style="max-width:560px;padding:24px;">',
      '<h1 style="font-size:18px;margin:0 0 8px;">Overlord could not load</h1>',
      `<p style="color:#a1a1aa;line-height:1.5;margin:0 0 12px;">${escapeHtml(errorDescription)} (${errorCode})</p>`,
      `<p style="color:#71717a;line-height:1.5;margin:0;">${escapeHtml(validatedURL)}</p>`,
      '</main></body></html>'
    ].join('');
    window.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(message)}`);
  });
  window.once('ready-to-show', () => window.show());
  setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  }, 3000);
  return window;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Native right-click menu. Because the renderer is sandboxed with no Node
 * access, the SPA cannot build an OS-native context menu itself — the shell
 * provides one. In editable fields it offers spellcheck suggestions (wired to
 * the `spellcheck: true` web preference) plus the standard editing roles; over a
 * plain text selection it offers copy/select-all. Anywhere else it stays out of
 * the way.
 */
export function registerNativeContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    const hasSelection = Boolean(params.selectionText?.trim());

    if (params.isEditable) {
      if (params.misspelledWord) {
        const suggestions = params.dictionarySuggestions.slice(0, 6);
        if (suggestions.length > 0) {
          template.push(
            ...suggestions.map(suggestion => ({
              label: suggestion,
              click: () => window.webContents.replaceMisspelling(suggestion)
            }))
          );
        } else {
          template.push({
            label: 'No spelling suggestions',
            enabled: false
          });
        }
        template.push({ type: 'separator' });
      }

      template.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      );
    } else if (hasSelection) {
      template.push({ role: 'copy' }, { type: 'separator' }, { role: 'selectAll' });
    }

    if (template.length === 0) return;

    Menu.buildFromTemplate(template).popup({ window });
  });
}

/**
 * Apply a loopback-scoped Content-Security-Policy to every response. Far simpler
 * than the closed app's CSP because there is no remote/Supabase origin: the
 * renderer and API share one `http://<host>:<port>` origin, so `'self'` already
 * covers the SPA's fetches and the SSE stream. We allow inline styles (the SPA's
 * theming injects them) and `data:`/`blob:` images/fonts.
 */
export function applyCsp({
  session,
  shellOrigin,
  apiOrigin
}: {
  session: Session;
  shellOrigin: string;
  apiOrigin?: string;
}): void {
  const connectOrigins = new Set<string>([
    "'self'",
    shellOrigin,
    shellOrigin.replace(/^http/, 'ws')
  ]);
  if (apiOrigin && apiOrigin !== shellOrigin) {
    connectOrigins.add(apiOrigin);
    connectOrigins.add(apiOrigin.replace(/^http/, 'ws'));
  }

  const csp = [
    `default-src 'self'`,
    // The SPA's index.html carries one tiny inline theme-bootstrap script; allow
    // exactly that one by hash rather than opening up 'unsafe-inline'. Keep this
    // hash in sync if that snippet ever changes.
    `script-src 'self' 'sha256-Y0NzcdWqLK5zUKdExAf8aq3UxpIzkXbzq9budSiMuvc='`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src ${[...connectOrigins].join(' ')}`,
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
export function guardNavigation(window: BrowserWindow, shellOrigin: string): void {
  const isExternal = (target: string): boolean => {
    try {
      return new URL(target).origin !== shellOrigin;
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
