import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  session
} from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveActiveBackend, sessionPartitionForProfile } from './backend-profiles.js';
import {
  type BackendRuntimeController,
  bootActiveBackend,
  createBackendRuntimeController,
  resolveInitialShellOrigin,
  stopAllBackendServers
} from './backend-runtime.js';
import { hydrateLocalDesktopSessionFromCliAuth } from './cli-auth-sync.js';
import { CliUpdater } from './cli-updater.js';
import { registerIpc } from './ipc.js';
import {
  hideQuickTaskWindow,
  initQuickTaskWindow,
  setQuickTaskBackend,
  unregisterQuickTaskHotkey
} from './quick-task-window.js';
import { DesktopUpdater } from './updater.js';
import { applyCsp, createWindow, guardNavigation } from './window.js';

loadDesktopEnvDefaults();

const PRELOAD = path.join(__dirname, 'preload.cjs');
const SPLASH = path.join(__dirname, 'splash.html');

const HOST = process.env.OVERLORD_WEB_HOST ?? '127.0.0.1';
const PREFERRED_PORT = parsePort(process.env.OVERLORD_WEB_PORT, 4310, 'OVERLORD_WEB_PORT');

const DEV_CONNECT = process.env.OVERLORD_DESKTOP_DEV === '1';
const DEV_URL = process.env.OVERLORD_DESKTOP_URL ?? `http://${HOST}:${PREFERRED_PORT}`;

let mainWindow: BrowserWindow | null = null;
let shellOrigin = `http://${HOST}:${PREFERRED_PORT}`;
let backendController: BackendRuntimeController | null = null;
let updater: DesktopUpdater | null = null;
let cliUpdater: CliUpdater | null = null;

process.env.OVERLORD_DESKTOP_VERSION = app.getVersion();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showOrCreateMainWindow();
  });

  app
    .whenReady()
    .then(boot)
    .catch(error => {
      dialog.showErrorBox('Overlord failed to start', describe(error));
      app.quit();
    });
}

async function boot(): Promise<void> {
  ensurePackagedConfig();
  shellOrigin = await resolveInitialShellOrigin({
    host: HOST,
    preferredPort: PREFERRED_PORT,
    devConnect: DEV_CONNECT,
    devUrl: DEV_URL
  });

  backendController = createBackendRuntimeController({
    host: HOST,
    preferredPort: PREFERRED_PORT,
    devConnect: DEV_CONNECT,
    devUrl: DEV_URL,
    recreateWindow: async ({ shellOrigin: nextShellOrigin, active }) => {
      shellOrigin = nextShellOrigin;
      configureSessionPolicy(active);
      return openMainWindow({ reloadExisting: true });
    }
  });

  updater = new DesktopUpdater(
    () => mainWindow,
    () => installApplicationMenu(updater!)
  );
  cliUpdater = new CliUpdater(() => mainWindow);
  installApplicationMenu(updater);
  registerIpc({
    getWindow: () => mainWindow,
    updater,
    cliUpdater,
    preloadPath: PRELOAD,
    getShellOrigin: () => shellOrigin,
    getBackendController: () => backendController
  });

  const { active, healthy } = await bootActiveBackend({
    shellOrigin,
    host: HOST,
    devConnect: DEV_CONNECT
  });
  configureSessionPolicy(active);
  if (active.mode === 'local') {
    hydrateLocalDesktopSessionFromCliAuth({ backendUrl: active.apiBaseUrl });
  }

  if (!healthy) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: 'Overlord',
      message: 'Overlord could not start',
      detail: startupFailureMessage(active),
      buttons: ['Retry', 'Quit'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) {
      await boot();
      return;
    }
    app.quit();
    return;
  }

  await openMainWindow({ reloadExisting: false });
  initQuickTaskWindow({
    appOrigin: shellOrigin,
    preloadPath: PRELOAD,
    partition: sessionPartitionForProfile(active.id)
  });
  updater.startAutomaticChecks();
  cliUpdater.startAutomaticChecks();

  app.on('activate', () => {
    showOrCreateMainWindow();
  });
}

function showOrCreateMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void openMainWindow({ reloadExisting: false });
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function configureSessionPolicy(active: ReturnType<typeof resolveActiveBackend>): void {
  const partition = session.fromPartition(sessionPartitionForProfile(active.id));
  applyCsp({
    session: partition,
    shellOrigin: active.shellOrigin,
    apiOrigin: active.apiBaseUrl
  });
}

async function openMainWindow({
  reloadExisting
}: {
  reloadExisting: boolean;
}): Promise<BrowserWindow | null> {
  const active = resolveActiveBackend({ shellOrigin });
  const partition = sessionPartitionForProfile(active.id);

  if (reloadExisting && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
    mainWindow = null;
  }

  mainWindow = createWindow({ preloadPath: PRELOAD, partition });
  guardNavigation(mainWindow, active.shellOrigin);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadFile(SPLASH);

  if (!mainWindow) return null;

  await mainWindow.loadURL(`${active.shellOrigin}/`);
  setQuickTaskBackend({
    appOrigin: active.shellOrigin,
    partition: sessionPartitionForProfile(active.id)
  });
  return mainWindow;
}

function startupFailureMessage(active: ReturnType<typeof resolveActiveBackend>): string {
  if (active.mode === 'remote') {
    return `Could not reach ${active.label} at ${active.apiBaseUrl}.\nCheck the URL and your network connection, then retry or switch back to Local.`;
  }
  if (DEV_CONNECT) {
    return `Could not reach the Overlord dev server at ${shellOrigin}.\nStart it with \`ovld serve\` (or \`yarn start\`) and retry.`;
  }
  return `The Overlord server did not become ready at ${shellOrigin}.`;
}

function loadDesktopEnvDefaults(): void {
  const envDir = app.isPackaged ? process.resourcesPath : path.resolve(app.getAppPath(), '..');
  const fileName = app.isPackaged ? '.env.prod' : '.env.local';
  loadEnvFile(path.join(envDir, fileName));
}

function ensurePackagedConfig(): void {
  if (!app.isPackaged) return;
  const targetPath = globalConfigPath();
  if (existsSync(targetPath)) return;

  const webHost = process.env.OVERLORD_WEB_HOST?.trim() || HOST;
  const webPort = parsePort(process.env.OVERLORD_WEB_PORT, PREFERRED_PORT, 'OVERLORD_WEB_PORT');
  const sqlStudioHost = process.env.OVERLORD_SQL_STUDIO_HOST?.trim() || '127.0.0.1';
  const sqlStudioPort = parsePort(
    process.env.OVERLORD_SQL_STUDIO_PORT,
    4311,
    'OVERLORD_SQL_STUDIO_PORT'
  );
  const sqlStudioBinary = process.env.OVERLORD_SQL_STUDIO_BINARY?.trim() || 'sql-studio';

  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(
    targetPath,
    `# Overlord local instance configuration
instance_name = "Local Overlord"
backend_mode = "local"
backend_url = ${tomlString(`http://${webHost === '0.0.0.0' ? '127.0.0.1' : webHost}:${webPort}`)}
web_host = ${tomlString(webHost)}
web_port = ${webPort}
sql_studio_enabled = false
sql_studio_host = ${tomlString(sqlStudioHost)}
sql_studio_port = ${sqlStudioPort}
sql_studio_binary = ${tomlString(sqlStudioBinary)}
default_agent = "claude"
`
  );
}

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = parseEnvValue(trimmed.slice(eq + 1));
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}

function parseEnvValue(rawValue: string): string {
  let value = rawValue.trim();
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && (i === 0 || value[i - 1] !== '\\')) {
      quote = quote === char ? null : (quote ?? char);
      continue;
    }
    if (char === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) {
      value = value.slice(0, i).trim();
      break;
    }
  }

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return value;
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const raw = value?.trim();
  if (!raw) return fallback;

  const port = Number(raw);
  if (Number.isInteger(port) && port >= 0 && port < 65536) return port;

  console.warn(`[desktop] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

function globalConfigPath(): string {
  return path.join(
    process.env.OVLD_HOME?.trim() || path.join(os.homedir(), '.ovld'),
    'overlord.toml'
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

app.on('before-quit', () => {
  updater?.stopAutomaticChecks();
  cliUpdater?.stopAutomaticChecks();
  unregisterQuickTaskHotkey();
  hideQuickTaskWindow();
  stopAllBackendServers();
});

app.on('window-all-closed', () => {
  app.quit();
});

function installApplicationMenu(updater: DesktopUpdater): void {
  const isMac = process.platform === 'darwin';
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: 'Check for Updates...',
    click: () => {
      void updater.checkForUpdatesWithDialog();
    }
  };
  const installUpdateItem: MenuItemConstructorOptions[] = updater.isUpdateReadyToInstall()
    ? [
        {
          label: 'Install Update and Relaunch',
          click: () => {
            void updater.showInstallDialog();
          }
        }
      ]
    : [];
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              checkForUpdatesItem,
              ...installUpdateItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : ([] as MenuItemConstructorOptions[])),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(!isMac
      ? ([
          {
            role: 'help',
            submenu: [checkForUpdatesItem, ...installUpdateItem]
          }
        ] as MenuItemConstructorOptions[])
      : ([] as MenuItemConstructorOptions[]))
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
