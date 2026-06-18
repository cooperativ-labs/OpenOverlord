import { AlertTriangle, Check, Copy, Info, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';

import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';

import { useSystemNotifications } from './SystemNotificationContext';
import type { SystemNotificationType } from './types';

function notificationIcon(type: SystemNotificationType) {
  switch (type) {
    case 'update':
      return <RefreshCw className="h-3.5 w-3.5 shrink-0" />;
    case 'warning':
      return <AlertTriangle className="h-3.5 w-3.5 shrink-0" />;
    case 'info':
      return <Info className="h-3.5 w-3.5 shrink-0" />;
  }
}

function notificationColor(type: SystemNotificationType) {
  switch (type) {
    case 'update':
      return 'border-blue-500/30 bg-blue-100/80 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300';
    case 'warning':
      return 'border-amber-500/30 bg-amber-100/80 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300';
    case 'info':
      return 'border-border bg-popover/50 text-popover-foreground dark:bg-popover/50 dark:text-popover-foreground';
  }
}

export function SystemNotificationBanner() {
  const { notifications, dismissNotification } = useSystemNotifications();
  const [actionStates, setActionStates] = useState<Record<string, ButtonLoadingState>>({});
  const [copiedIds, setCopiedIds] = useState<Record<string, boolean>>({});

  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex max-w-sm flex-col gap-2 duration-200 animate-in fade-in slide-in-from-bottom-2">
      {notifications.map(notification => (
        <div
          key={notification.id}
          className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-md backdrop-blur-lg ${notificationColor(notification.type)}`}
        >
          <div className="mt-0.5">{notificationIcon(notification.type)}</div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium leading-tight">{notification.title}</p>
            <p className="mt-0.5 text-xs leading-snug opacity-80">{notification.message}</p>
            {notification.action && (
              <LoadingButton
                buttonState={actionStates[notification.id] ?? 'default'}
                setButtonState={state =>
                  setActionStates(prev => ({ ...prev, [notification.id]: state }))
                }
                text={notification.action.label}
                loadingText={notification.action.loadingText}
                successText={notification.action.successText}
                onClick={async () => {
                  const setState = (state: ButtonLoadingState) =>
                    setActionStates(prev => ({ ...prev, [notification.id]: state }));
                  setState('loading');
                  try {
                    await notification.action!.onClick();
                    setState('success');
                    setTimeout(() => setState('default'), 2000);
                  } catch {
                    setState('error');
                    setTimeout(() => setState('default'), 2000);
                  }
                }}
                variant="link"
                size="sm"
                className="mt-1.5 h-auto p-0 text-xs font-medium underline underline-offset-2 hover:no-underline"
              />
            )}
            {notification.copyCommand && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] dark:bg-white/10">
                  {notification.copyCommand}
                </code>
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(notification.copyCommand!);
                    setCopiedIds(prev => ({ ...prev, [notification.id]: true }));
                    window.setTimeout(() => {
                      setCopiedIds(prev => ({ ...prev, [notification.id]: false }));
                    }, 2000);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium opacity-80 transition-opacity hover:opacity-100"
                >
                  {copiedIds[notification.id] ? (
                    <>
                      <Check className="h-3 w-3" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      Copy
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismissNotification(notification.id)}
            className="-m-1 shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
          >
            <span className="sr-only">Dismiss</span>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
