import { Play, Square } from 'lucide-react';
import type { MouseEvent } from 'react';

import {
  useEverhourIntegration,
  useMissionEverhour,
  useStartMissionTimer,
  useStopMissionTimer
} from '@/lib/queries';
import { cn } from '@/lib/utils';

import { formatClock, useLiveSeconds } from '../../lib/everhour.ts';

/**
 * Shared timer state + start/stop control for one mission. Returns `connected:
 * false` when the workspace has no Everhour API key, so callers can render
 * nothing. `liveSeconds` ticks locally while the timer runs.
 */
export function useMissionTimerControls(missionId: string, options: { poll?: boolean } = {}) {
  const integration = useEverhourIntegration();
  const connected = integration.data?.connected ?? false;
  const everhour = useMissionEverhour(missionId, { enabled: connected, poll: options.poll });
  const start = useStartMissionTimer(missionId);
  const stop = useStopMissionTimer(missionId);

  const running = Boolean(everhour.data?.runningTimer);
  const baseSeconds = everhour.data?.runningTimer?.durationSeconds ?? 0;
  const liveSeconds = useLiveSeconds(baseSeconds, everhour.dataUpdatedAt, running);
  const busy = start.isPending || stop.isPending;

  const toggle = () => {
    if (busy) return;
    if (running) stop.mutate();
    else start.mutate();
  };

  return { connected, running, liveSeconds, busy, toggle, state: everhour.data };
}

/**
 * Small play/stop circle for dense surfaces (e.g. the mission card hover footer).
 * Idle: gray play, green on hover. Running: red stop. Renders nothing when the
 * workspace isn't connected to Everhour.
 */
export function MissionTimerCircleButton({
  missionId,
  className
}: {
  missionId: string;
  className?: string;
}) {
  const { connected, running, busy, toggle } = useMissionTimerControls(missionId);
  if (!connected) return null;

  const handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    toggle();
  };

  return (
    <button
      type="button"
      aria-label={running ? 'Stop timer' : 'Start timer'}
      title={running ? 'Stop timer' : 'Start timer'}
      onClick={handleClick}
      onPointerDown={event => event.stopPropagation()}
      disabled={busy}
      className={cn(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-50',
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
    </button>
  );
}

/**
 * Pill timer toggle: play/stop icon + elapsed clock. Idle shows "Start" in gray
 * (green on hover); running shows a red stop pill with the live elapsed time.
 * Clicking toggles the timer. Renders nothing when not connected.
 */
export function MissionTimerPill({
  missionId,
  className
}: {
  missionId: string;
  className?: string;
}) {
  const { connected, running, liveSeconds, busy, toggle } = useMissionTimerControls(missionId, {
    poll: true
  });
  if (!connected) return null;

  return (
    <button
      type="button"
      aria-label={running ? 'Stop timer' : 'Start timer'}
      onClick={event => {
        event.stopPropagation();
        toggle();
      }}
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
