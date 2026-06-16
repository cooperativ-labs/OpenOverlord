import { app, type BrowserWindow, dialog } from 'electron';
import { autoUpdater, type ProgressInfo } from 'electron-updater';

import { DEFAULT_UPDATE_FEED_URL } from '../update-feed.js';

export type DesktopUpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'unsupported';

export type DesktopUpdateStatus = {
  state: DesktopUpdateState;
  currentVersion: string;
  availableVersion: string | null;
  message: string | null;
  progressPercent: number | null;
};

type GetWindow = () => BrowserWindow | null;

const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export class DesktopUpdater {
  private status: DesktopUpdateStatus = {
    state: 'idle',
    currentVersion: app.getVersion(),
    availableVersion: null,
    message: null,
    progressPercent: null
  };

  private autoCheckTimer: NodeJS.Timeout | null = null;

  constructor(private readonly getWindow: GetWindow) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = console;

    const feedUrl =
      process.env.OVERLORD_UPDATE_FEED_URL ??
      (app.isPackaged ? DEFAULT_UPDATE_FEED_URL : undefined);
    if (feedUrl) autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });

    autoUpdater.on('checking-for-update', () => {
      this.setStatus({
        state: 'checking',
        availableVersion: null,
        progressPercent: null,
        message: 'Checking for updates.'
      });
    });

    autoUpdater.on('update-available', info => {
      this.setStatus({
        state: 'available',
        availableVersion: info.version,
        message: `Version ${info.version} is available.`
      });
    });

    autoUpdater.on('download-progress', (info: ProgressInfo) => {
      this.setStatus({
        state: 'downloading',
        progressPercent: Math.max(0, Math.min(100, info.percent)),
        message: `Downloading ${Math.round(info.percent)}%.`
      });
    });

    autoUpdater.on('update-downloaded', info => {
      this.setStatus({
        state: 'downloaded',
        availableVersion: info.version,
        progressPercent: 100,
        message: `Version ${info.version} is ready to install.`
      });
    });

    autoUpdater.on('update-not-available', info => {
      this.setStatus({
        state: 'not-available',
        availableVersion: info.version,
        progressPercent: null,
        message: 'Overlord is up to date.'
      });
    });

    autoUpdater.on('error', error => {
      this.setStatus({
        state: 'error',
        progressPercent: null,
        message: error.message
      });
    });
  }

  getStatus(): DesktopUpdateStatus {
    return { ...this.status };
  }

  startAutomaticChecks(): void {
    if (!this.canCheckForUpdates()) {
      this.setStatus({
        state: 'unsupported',
        message: 'Update checks are available in packaged builds.'
      });
      return;
    }

    void this.checkForUpdates();
    this.autoCheckTimer = setInterval(() => {
      void this.checkForUpdates();
    }, AUTO_CHECK_INTERVAL_MS);
  }

  stopAutomaticChecks(): void {
    if (!this.autoCheckTimer) return;
    clearInterval(this.autoCheckTimer);
    this.autoCheckTimer = null;
  }

  async checkForUpdates(): Promise<DesktopUpdateStatus> {
    if (!this.canCheckForUpdates()) {
      this.setStatus({
        state: 'unsupported',
        message: 'Update checks are available in packaged builds.'
      });
      return this.getStatus();
    }

    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        this.setStatus({
          state: 'unsupported',
          message: 'No update feed is configured for this build.'
        });
      } else if (!result.isUpdateAvailable) {
        this.setStatus({
          state: 'not-available',
          availableVersion: result.updateInfo.version,
          progressPercent: null,
          message: 'Overlord is up to date.'
        });
      }
    } catch (error) {
      this.setStatus({
        state: 'error',
        progressPercent: null,
        message: describe(error)
      });
    }

    return this.getStatus();
  }

  installDownloadedUpdate(): DesktopUpdateStatus {
    if (this.status.state !== 'downloaded') return this.getStatus();
    autoUpdater.quitAndInstall(false, true);
    return this.getStatus();
  }

  async checkForUpdatesWithDialog(): Promise<void> {
    const status = await this.checkForUpdates();
    const window = this.getWindow();

    if (status.state === 'downloaded') {
      await this.showInstallDialog(status);
      return;
    }

    if (status.state === 'available' || status.state === 'downloading') {
      await this.showMessage('Overlord update', status.message ?? 'Downloading update.');
      return;
    }

    if (status.state === 'not-available') {
      await this.showMessage('Overlord update', 'Overlord is up to date.');
      return;
    }

    if (window) {
      await dialog.showMessageBox(window, {
        type: 'error',
        title: 'Overlord update',
        message: 'Could not check for updates',
        detail: status.message ?? 'No update details were available.'
      });
    } else {
      dialog.showErrorBox('Overlord update', status.message ?? 'Could not check for updates.');
    }
  }

  async showInstallDialog(status = this.status): Promise<void> {
    if (status.state !== 'downloaded') return;

    const window = this.getWindow();
    const options = {
      type: 'info' as const,
      title: 'Overlord update',
      message: `Version ${status.availableVersion ?? 'update'} is ready to install.`,
      buttons: ['Install and relaunch', 'Later'],
      defaultId: 0,
      cancelId: 1
    };
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

    if (result.response === 0) this.installDownloadedUpdate();
  }

  private canCheckForUpdates(): boolean {
    return app.isPackaged || Boolean(process.env.OVERLORD_UPDATE_FEED_URL);
  }

  private setStatus(next: Partial<DesktopUpdateStatus>): void {
    this.status = { ...this.status, ...next };
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send('overlord:updates:status', this.getStatus());
  }

  private async showMessage(title: string, message: string): Promise<void> {
    const window = this.getWindow();
    const options = { type: 'info' as const, title, message };
    if (window) await dialog.showMessageBox(window, options);
    else await dialog.showMessageBox(options);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
