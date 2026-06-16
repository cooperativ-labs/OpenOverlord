import { Download, RefreshCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const initialStatus: DesktopUpdateStatus = {
  state: 'idle',
  currentVersion: 'unknown',
  availableVersion: null,
  message: null,
  progressPercent: null
};

const stateLabels: Record<DesktopUpdateState, string> = {
  idle: 'Idle',
  checking: 'Checking',
  available: 'Available',
  'not-available': 'Up to date',
  downloading: 'Downloading',
  downloaded: 'Ready',
  error: 'Error',
  unsupported: 'Unavailable'
};

export function DesktopUpdatesPage() {
  const bridge = typeof window === 'undefined' ? undefined : window.overlord;
  const [status, setStatus] = useState<DesktopUpdateStatus>(initialStatus);
  const [busyAction, setBusyAction] = useState<'check' | 'install' | null>(null);

  useEffect(() => {
    if (!bridge?.updates) return;

    let mounted = true;
    bridge.updates.getStatus().then(next => {
      if (mounted) setStatus(next);
    });
    const unsubscribe = bridge.updates.onStatus(next => {
      if (mounted) setStatus(next);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [bridge]);

  const detail = useMemo(() => {
    if (!bridge?.updates) return 'Open Overlord in the desktop app to manage updates.';
    if (status.message) return status.message;
    if (status.availableVersion) return `Latest: v${status.availableVersion}`;
    return `Current: v${status.currentVersion}`;
  }, [bridge, status]);

  const canCheck =
    Boolean(bridge?.updates) && status.state !== 'checking' && status.state !== 'downloading';
  const canInstall = Boolean(bridge?.updates) && status.state === 'downloaded';

  async function checkForUpdates() {
    if (!bridge?.updates || !canCheck) return;
    setBusyAction('check');
    try {
      setStatus(await bridge.updates.check());
    } finally {
      setBusyAction(null);
    }
  }

  async function installUpdate() {
    if (!bridge?.updates || !canInstall) return;
    setBusyAction('install');
    try {
      setStatus(await bridge.updates.install());
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Desktop</h2>
        <p className="text-sm text-muted-foreground">Version and update controls.</p>
      </div>

      <div className="max-w-xl rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">Overlord v{status.currentVersion}</h3>
              <Badge variant={status.state === 'error' ? 'destructive' : 'secondary'}>
                {stateLabels[status.state]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{detail}</p>
            {status.state === 'downloading' && status.progressPercent !== null ? (
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${status.progressPercent}%` }}
                />
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void checkForUpdates()}
              disabled={!canCheck || busyAction !== null}
            >
              <RefreshCcw className={busyAction === 'check' ? 'animate-spin' : undefined} />
              Check
            </Button>
            <Button
              type="button"
              onClick={() => void installUpdate()}
              disabled={!canInstall || busyAction !== null}
            >
              <Download />
              Install
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
