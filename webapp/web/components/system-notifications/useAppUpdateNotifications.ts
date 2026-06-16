import { useEffect } from 'react';

import { useSystemNotifications } from './SystemNotificationContext';

const AVAILABLE_NOTIFICATION_ID = 'app-update-available';
const DOWNLOADED_NOTIFICATION_ID = 'app-update-downloaded';

function dismissKeyForVersion(status: DesktopUpdateStatus): string {
  const version = status.availableVersion ?? status.currentVersion;
  return `overlord-app-update-${version}`;
}

/**
 * Surfaces a system notification when the desktop shell reports an update is
 * available or ready to install. Feature-detects the `window.overlord.updates`
 * bridge; on the web (no shell) it does nothing.
 *
 * The shell's updater auto-downloads, so there is no separate "download"
 * action: an available/downloading update is shown as informational, and the
 * downloaded update offers a "Restart now" action that calls
 * `window.overlord.updates.install()` (quit-and-install).
 */
export function useAppUpdateNotifications() {
  const { addNotification, dismissNotification } = useSystemNotifications();

  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.overlord;
    if (!bridge?.updates) return;

    let cancelled = false;

    const clearNotifications = () => {
      dismissNotification(AVAILABLE_NOTIFICATION_ID);
      dismissNotification(DOWNLOADED_NOTIFICATION_ID);
    };

    const syncNotification = (status: DesktopUpdateStatus) => {
      if (cancelled) return;

      if (status.state === 'available' || status.state === 'downloading') {
        dismissNotification(DOWNLOADED_NOTIFICATION_ID);
        addNotification({
          id: AVAILABLE_NOTIFICATION_ID,
          type: 'update',
          title: 'App update available',
          message: `Version ${status.availableVersion ?? 'latest'} is downloading in the background.`,
          dismissKey: dismissKeyForVersion(status)
        });
        return;
      }

      if (status.state === 'downloaded') {
        dismissNotification(AVAILABLE_NOTIFICATION_ID);
        addNotification({
          id: DOWNLOADED_NOTIFICATION_ID,
          type: 'update',
          title: 'App update ready to install',
          message: `Version ${status.availableVersion ?? 'latest'} has finished downloading.`,
          dismissKey: `${dismissKeyForVersion(status)}-downloaded`,
          action: {
            label: 'Restart now',
            loadingText: 'Restarting…',
            onClick: () => {
              void bridge.updates.install();
            }
          }
        });
        return;
      }

      clearNotifications();
    };

    bridge.updates
      .getStatus()
      .then(syncNotification)
      .catch(() => {
        clearNotifications();
      });

    const unsubscribe = bridge.updates.onStatus(syncNotification);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [addNotification, dismissNotification]);
}
