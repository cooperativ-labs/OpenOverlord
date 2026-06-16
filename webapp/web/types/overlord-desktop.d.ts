export {};

declare global {
  type DesktopUpdateState =
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'unsupported';

  type DesktopUpdateStatus = {
    state: DesktopUpdateState;
    currentVersion: string;
    availableVersion: string | null;
    message: string | null;
    progressPercent: number | null;
  };

  type OverlordDesktopBridge = {
    isDesktop: true;
    platform: NodeJS.Platform;
    version: string | null;
    chooseDirectory: () => Promise<string | null>;
    openExternal: (url: string) => Promise<boolean>;
    revealInFinder: (path: string) => Promise<boolean>;
    updates: {
      getStatus: () => Promise<DesktopUpdateStatus>;
      check: () => Promise<DesktopUpdateStatus>;
      install: () => Promise<DesktopUpdateStatus>;
      onStatus: (callback: (status: DesktopUpdateStatus) => void) => () => void;
    };
  };

  interface Window {
    overlord?: OverlordDesktopBridge;
  }
}
