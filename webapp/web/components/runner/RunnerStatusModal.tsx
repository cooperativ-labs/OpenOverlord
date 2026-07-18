import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2, Power, RefreshCw, RotateCw, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';
import { keys, useRunnerStatus } from '@/lib/queries';
import { hasRunnerQueueError, runnerQueueErrorMessage } from '@/lib/runner-status';
import { cn } from '@/lib/utils';

/** Shape of the parsed CLI `runner service status --json` payload. */
interface ServiceStatus {
  supported?: boolean;
  kind?: string;
  installed?: boolean;
  running?: 'running' | 'stopped' | 'unknown' | string;
  backendUrl?: string | null;
  lastHeartbeatAt?: string | null;
  lastLaunchedAt?: string | null;
  lastError?: string | null;
  currentPollIntervalMs?: number | null;
}

const SERVICE_INSTALL_COMMAND = 'ovld runner service install --start';
const FOREGROUND_COMMAND = 'ovld runner start';

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'unknown';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function CommandRow({ command }: { command: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs">
        {command}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0"
        onClick={() => void copy(command)}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/**
 * Live control panel for the persistent runner service, shown when the SPA runs
 * inside the desktop shell (which can spawn the CLI-owned `ovld runner service`
 * operations). Falls back to copyable commands in a plain browser.
 */
function ServiceControls() {
  const bridge = typeof window === 'undefined' ? undefined : window.overlord;
  const runnerService = bridge?.runnerService;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!runnerService) return;
    setBusy('status');
    setError(null);
    try {
      const result = await runnerService.getStatus();
      if (!result.ok) setError(result.error ?? 'Failed to read runner service status.');
      setStatus((result.status as ServiceStatus | null) ?? null);
      // Keep the sidebar runner box (useRunnerServiceStatus) in step with what
      // the control panel just observed, without waiting for its next poll.
      queryClient.setQueryData(
        keys.runnerServiceStatus,
        result.ok ? (result.status ?? null) : null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read runner service status.');
    } finally {
      setBusy(null);
    }
  }, [runnerService, queryClient]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!runnerService) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Enable a persistent runner so queued objectives launch automatically — run this once in
          your terminal:
        </p>
        <CommandRow command={SERVICE_INSTALL_COMMAND} />
        <p className="text-xs text-muted-foreground pt-1">
          Or run a foreground runner while a terminal stays open:
        </p>
        <CommandRow command={FOREGROUND_COMMAND} />
      </div>
    );
  }

  if (status?.supported === false) {
    return (
      <p className="text-xs text-muted-foreground">
        The persistent runner service is not supported on this platform yet. Use{' '}
        <code className="font-mono">ovld runner start</code> for a foreground runner.
      </p>
    );
  }

  const run = async (action: 'install' | 'start' | 'stop' | 'restart' | 'uninstall') => {
    setBusy(action);
    setError(null);
    try {
      const op =
        action === 'install'
          ? runnerService.install({ noStart: true })
          : action === 'start'
            ? runnerService.start()
            : action === 'stop'
              ? runnerService.stop()
              : action === 'restart'
                ? runnerService.restart()
                : runnerService.uninstall();
      const result = await op;
      if (!result.ok) setError(result.error ?? `Failed to ${action} the runner service.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} the runner service.`);
    } finally {
      setBusy(null);
    }
  };

  const installed = status?.installed === true;
  const running = status?.running === 'running';

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">State</dt>
        <dd className="font-medium">
          {!installed ? 'Not installed' : running ? 'Running' : 'Stopped'}
        </dd>
        <dt className="text-muted-foreground">Poll interval</dt>
        <dd>{status?.currentPollIntervalMs ? `${status.currentPollIntervalMs} ms` : 'idle'}</dd>
        <dt className="text-muted-foreground">Last heartbeat</dt>
        <dd>{relativeTime(status?.lastHeartbeatAt)}</dd>
        <dt className="text-muted-foreground">Last launch</dt>
        <dd>{relativeTime(status?.lastLaunchedAt)}</dd>
      </dl>

      {status?.lastError ? <p className="text-xs text-destructive">{status.lastError}</p> : null}

      <div className="flex flex-wrap gap-2">
        {!installed ? (
          <Button size="sm" onClick={() => void run('install')} disabled={busy !== null}>
            {busy === 'install' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Power className="size-3.5" />
            )}
            Install service
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant={running ? 'outline' : 'default'}
              onClick={() => void run(running ? 'stop' : 'start')}
              disabled={busy !== null}
            >
              {busy === 'start' || busy === 'stop' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : running ? (
                <Square className="size-3.5" />
              ) : (
                <Power className="size-3.5" />
              )}
              {running ? 'Disable' : 'Enable'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run('restart')}
              disabled={busy !== null || !running}
            >
              {busy === 'restart' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCw className="size-3.5" />
              )}
              Restart
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => void run('uninstall')}
              disabled={busy !== null}
            >
              {busy === 'uninstall' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Uninstall service
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy !== null}>
          <RefreshCw className={cn('size-3.5', busy === 'status' && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'failed' || status === 'expired') return 'destructive';
  if (status === 'launched') return 'default';
  if (status === 'claimed' || status === 'launching') return 'secondary';
  return 'outline';
}

export function RunnerStatusModal({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  // Share the sidebar's always-on query — do not pass `enabled: open`, which would
  // thrash the shared Query options to disabled whenever the modal is closed.
  const runner = useRunnerStatus({ refetchInterval: open ? 5_000 : 15_000 });
  const queue = runner.data?.queue ?? [];
  const queueError = hasRunnerQueueError({
    isLoadingError: runner.isLoadingError,
    isFetching: runner.isFetching,
    data: runner.data,
    errorUpdateCount: runner.errorUpdateCount
  });
  const queueErrorDetail =
    runnerQueueErrorMessage(runner.error) ?? runnerQueueErrorMessage(runner.failureReason);

  const clear = useMutation({
    mutationFn: () => api.clearRunnerQueue({}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.runnerStatus })
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Runner</DialogTitle>
          <DialogDescription>
            Queued work and the persistent runner that launches it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Queue</h3>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {queueError
                    ? 'unavailable'
                    : `${queue.length} ${queue.length === 1 ? 'request' : 'requests'}`}
                </span>
                {queue.length > 0 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-destructive"
                    onClick={() => clear.mutate()}
                    disabled={clear.isPending}
                  >
                    {clear.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
            {queueError ? (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Could not load the runner queue right now.
                </p>
                {queueErrorDetail ? (
                  <p className="text-xs text-destructive break-words">{queueErrorDetail}</p>
                ) : null}
              </div>
            ) : queue.length === 0 ? (
              <p className="text-xs text-muted-foreground">No execution requests are queued.</p>
            ) : (
              <ul className="space-y-1.5">
                {queue.slice(0, 8).map(request => (
                  <li
                    key={request.id}
                    className="flex items-center justify-between gap-2 rounded border border-border/60 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {request.requestedAgent ?? 'agent'}
                      {request.missionId ? (
                        <span className="text-muted-foreground">
                          {' '}
                          · {request.missionId.slice(0, 8)}
                        </span>
                      ) : null}
                    </span>
                    <Badge variant={statusBadgeVariant(request.status)}>{request.status}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2 border-t border-border pt-4">
            <h3 className="text-sm font-medium">Persistent runner</h3>
            <ServiceControls />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
