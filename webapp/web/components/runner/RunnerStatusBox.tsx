import { Radio } from 'lucide-react';
import { useState } from 'react';

import { RunnerStatusModal } from '@/components/runner/RunnerStatusModal';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { useRunnerServiceStatus, useRunnerStatus } from '@/lib/queries';
import { cn } from '@/lib/utils';

type RunnerState = 'active' | 'ready' | 'idle' | 'error';

function deriveState({
  isError,
  activeCount,
  serviceRunning
}: {
  isError: boolean;
  activeCount: number;
  serviceRunning: boolean;
}): RunnerState {
  if (isError) return 'error';
  if (activeCount > 0) return 'active';
  return serviceRunning ? 'ready' : 'idle';
}

const STATE_LABEL: Record<RunnerState, string> = {
  active: 'Runner active',
  ready: 'Runner ready',
  idle: 'Runner idle',
  error: 'Runner unavailable'
};

const DOT_CLASS: Record<RunnerState, string> = {
  active: 'bg-emerald-500',
  ready: 'bg-emerald-500/70',
  idle: 'bg-muted-foreground/40',
  error: 'bg-amber-500'
};

/**
 * Subtle runner status box for the sidebar footer (between Settings and the user
 * menu). Shows a quiet indicator of the runner queue; clicking opens a modal
 * with detail and control over the persistent runner service. In the desktop
 * shell the local service state feeds in too, so a running persistent runner
 * reads as "ready" instead of "idle" while it waits for work.
 */
export function RunnerStatusBox() {
  const [open, setOpen] = useState(false);
  const runner = useRunnerStatus();
  const service = useRunnerServiceStatus();
  const activeCount = runner.data?.activeCount ?? 0;
  const serviceRunning = service.data?.running === 'running';
  const state = deriveState({ isError: runner.isError, activeCount, serviceRunning });

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() => setOpen(true)}
            tooltip={STATE_LABEL[state]}
            className="text-muted-foreground"
          >
            <span className="relative flex size-4 items-center justify-center">
              <Radio className="size-4" />
              <span
                className={cn(
                  'absolute -right-0.5 -top-0.5 size-2 rounded-full',
                  DOT_CLASS[state],
                  state === 'active' && 'animate-pulse'
                )}
              />
            </span>
            <span className="flex-1 truncate">{STATE_LABEL[state]}</span>
            {state === 'active' ? (
              <span className="ml-auto rounded-full bg-emerald-500/15 px-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                {activeCount}
              </span>
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      <RunnerStatusModal open={open} onOpenChange={setOpen} />
    </>
  );
}
