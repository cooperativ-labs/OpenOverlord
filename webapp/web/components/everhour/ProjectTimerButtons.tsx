import { Play, Square } from 'lucide-react';
import type { MouseEvent } from 'react';

import {
  useEverhourIntegration,
  useProjectEverhour,
  useStartProjectTimer,
  useStopProjectTimer
} from '@/lib/queries';
import { cn } from '@/lib/utils';

import { formatClock, useLiveSeconds } from '../../lib/everhour.ts';

/**
 * Shared timer state + start/stop control for one project's Everhour `general`
 * task. Returns `connected: false` when the workspace has no Everhour API key.
 */
export function useProjectTimerControls(projectId: string, options: { poll?: boolean } = {}) {
  const integration = useEverhourIntegration();
  const connected = integration.data?.connected ?? false;
  const everhour = useProjectEverhour(projectId, { enabled: connected, poll: options.poll });
  const start = useStartProjectTimer(projectId);
  const stop = useStopProjectTimer(projectId);

  const running = Boolean(everhour.data?.runningTimer);
  const baseSeconds = everhour.data?.runningTimer?.durationSeconds ?? 0;
  const liveSeconds = useLiveSeconds(baseSeconds, everhour.dataUpdatedAt, running);
  const busy = start.isPending || stop.isPending;

  const toggle = () => {
    if (busy) return;
    if (running) stop.mutate();
    else start.mutate();
  };

  return {
    connected,
    running,
    liveSeconds,
    busy,
    toggle,
    state: everhour.data,
    dataUpdatedAt: everhour.dataUpdatedAt
  };
}

/**
 * Pill timer toggle for project-level `general` time. Idle shows "Start";
 * running shows a red stop pill with the live elapsed time. Renders nothing
 * when the workspace isn't connected to Everhour.
 */
export function ProjectTimerPill({
  projectId,
  className
}: {
  projectId: string;
  className?: string;
}) {
  const { connected, running, liveSeconds, busy, toggle } = useProjectTimerControls(projectId, {
    poll: true
  });
  if (!connected) return null;

  const handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    toggle();
  };

  return (
    <button
      type="button"
      aria-label={running ? 'Stop project timer' : 'Start project timer'}
      title={running ? 'Stop project timer' : 'Start project timer'}
      onClick={handleClick}
      onPointerDown={event => event.stopPropagation()}
      disabled={busy}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium tabular-nums transition-colors disabled:opacity-50',
        running
          ? 'border-red-500/40 bg-red-500/15 text-red-500 hover:bg-red-500/25'
          : 'border-border bg-transparent text-muted-foreground hover:border-emerald-500/40 hover:bg-emerald-500/15 hover:text-emerald-500',
        className
      )}
    >
      {running ? (
        <Square className="h-3 w-3 fill-current" />
      ) : (
        <Play className="h-3 w-3 fill-current" />
      )}
      <span>{running ? formatClock(liveSeconds) : 'Start'}</span>
    </button>
  );
}
