import { useEffect, useState } from 'react';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { getDesktopChrome } from '@/lib/desktop-chrome';
import {
  isNativeNotificationsEnabled,
  setNativeNotificationsEnabled,
  subscribeNativeNotificationsEnabled
} from '@/lib/native-notification-preferences';

type PermissionStatus = NotificationPermission | 'unsupported';

function readPermissionStatus({ isDesktop }: { isDesktop: boolean }): PermissionStatus {
  if (isDesktop) return 'granted';
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

function permissionLabel(status: PermissionStatus): string {
  switch (status) {
    case 'granted':
      return 'Allowed';
    case 'denied':
      return 'Blocked';
    case 'default':
      return 'Not requested';
    case 'unsupported':
      return 'Unavailable';
  }
}

export function NotificationsPage() {
  const { isDesktop } = getDesktopChrome();
  const [enabled, setEnabled] = useState(() => isNativeNotificationsEnabled());
  const [permission, setPermission] = useState<PermissionStatus>(() =>
    readPermissionStatus({ isDesktop })
  );

  useEffect(() => subscribeNativeNotificationsEnabled(setEnabled), []);

  async function handleToggle(next: boolean) {
    if (next && !isDesktop && 'Notification' in window && Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      setPermission(result);
    }

    setNativeNotificationsEnabled({ enabled: next });
    setEnabled(next);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Native alerts when agents start work, ask blocking questions, or deliver for review.
        </p>
      </div>

      <div className="max-w-xl space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
          <div className="space-y-1">
            <Label htmlFor="native-notifications-toggle">Native notifications</Label>
            <p className="text-xs text-muted-foreground">
              {isDesktop
                ? 'Uses the desktop shell notification center. Stored on this machine.'
                : 'Uses your browser notification permission. Stored in this browser.'}
            </p>
          </div>
          <Switch
            id="native-notifications-toggle"
            checked={enabled}
            onCheckedChange={next => void handleToggle(next)}
          />
        </div>

        {!isDesktop ? (
          <div className="rounded-lg border px-4 py-3">
            <p className="text-sm">
              Browser permission:{' '}
              <span className="font-medium text-foreground">{permissionLabel(permission)}</span>
            </p>
            {permission === 'denied' ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Notifications are blocked in your browser settings. Allow them for this site, then
                turn the toggle on again.
              </p>
            ) : null}
            {permission === 'unsupported' ? (
              <p className="mt-1 text-xs text-muted-foreground">
                This browser does not support native notifications.
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="rounded-lg border px-4 py-3">
          <h3 className="text-sm font-medium">You will be notified when</h3>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            <li>An agent starts executing an objective</li>
            <li>An agent asks a blocking question</li>
            <li>An objective is delivered and ready for review</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
