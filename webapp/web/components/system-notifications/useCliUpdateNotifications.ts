import { useEffect } from 'react';

import { useSystemNotifications } from './SystemNotificationContext';

const CLI_UPDATE_NOTIFICATION_ID = 'cli-update-available';

function dismissKeyForVersion(status: CliUpdateStatus): string {
  const version = status.latestVersion ?? status.currentVersion ?? 'unknown';
  return `overlord-cli-update-${version}`;
}

/**
 * Surfaces a system notification when the desktop shell reports the installed
 * Overlord CLI is behind the latest published version. Feature-detects
 * `window.overlord.cliUpdates`; on the web (no shell) it does nothing.
 */
export function useCliUpdateNotifications() {
  const { addNotification, dismissNotification } = useSystemNotifications();

  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.overlord;
    if (!bridge?.cliUpdates) return;

    let cancelled = false;

    const clearNotification = () => {
      dismissNotification(CLI_UPDATE_NOTIFICATION_ID);
    };

    const syncNotification = (status: CliUpdateStatus) => {
      if (cancelled) return;

      if (status.state === 'available') {
        addNotification({
          id: CLI_UPDATE_NOTIFICATION_ID,
          type: 'update',
          title: 'CLI update available',
          message:
            status.message ??
            `Overlord CLI ${status.currentVersion ?? 'installed'} can be updated to ${status.latestVersion ?? 'latest'}.`,
          dismissKey: dismissKeyForVersion(status),
          copyCommand: status.updateCommand,
          action: {
            label: 'Update now',
            loadingText: 'Updating…',
            successText: 'Updated',
            onClick: () => {
              void bridge.cliUpdates!.update();
            }
          }
        });
        return;
      }

      if (status.state === 'updating') {
        addNotification({
          id: CLI_UPDATE_NOTIFICATION_ID,
          type: 'update',
          title: 'Updating CLI',
          message: status.message ?? 'Installing the latest Overlord CLI.',
          copyCommand: status.updateCommand
        });
        return;
      }

      clearNotification();
    };

    bridge.cliUpdates
      .getStatus()
      .then(syncNotification)
      .catch(() => {
        clearNotification();
      });

    const unsubscribe = bridge.cliUpdates.onStatus(syncNotification);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [addNotification, dismissNotification]);
}
