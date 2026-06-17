import { AlertTriangle, Bot, Check, ChevronDown, Copy, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';

import type { ExecutionRequestDto, ObjectiveDto } from '../../../shared/contract.ts';
import { api } from '../../lib/api.ts';
import { primaryResourceConnection } from '../../lib/project-resources.ts';
import { useLaunchObjective, useProjectResources } from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';

import type { AgentModelSelection } from './AgentModelSelector.tsx';

type AgentLaunchButtonSize = 'sm' | 'default';

type AgentLaunchButtonProps = {
  objective: ObjectiveDto;
  selection: AgentModelSelection;
  /** False until catalog + preference queries resolve; Run stays disabled. */
  selectionLoaded: boolean;
  /** True when another objective on the ticket is already executing/launching. */
  hasActiveSibling?: boolean;
  /** Active execution request already queued for this objective, if any. */
  activeRequest?: ExecutionRequestDto | null;
  size?: AgentLaunchButtonSize;
};

const sizeStyles: Record<
  AgentLaunchButtonSize,
  { runButton: string; caretButton: string; label: string; icon: string; chevron: string }
> = {
  sm: {
    runButton: 'h-8 px-3 text-xs font-medium',
    caretButton: 'h-8 px-1.5',
    label: 'text-xs',
    icon: 'h-3.5 w-3.5',
    chevron: 'h-3.5 w-3.5'
  },
  default: {
    runButton: 'h-9 px-4 text-sm font-medium',
    caretButton: 'h-9 px-2',
    label: 'text-sm',
    icon: 'h-3.5 w-3.5',
    chevron: 'h-3.5 w-3.5'
  }
};

/**
 * Split run button for an objective: the primary action queues an execution
 * request for the selected agent/model; the caret offers Run and a copyable
 * prompt for driving an agent manually. Mirrors the legacy AgentSplitButton:
 * confirm-before-queue when an agent is already working the ticket, and a
 * disabled-state tooltip explaining what is missing.
 */
export function AgentLaunchButton({
  objective,
  selection,
  selectionLoaded,
  hasActiveSibling = false,
  activeRequest = null,
  size = 'sm'
}: AgentLaunchButtonProps) {
  const launch = useLaunchObjective();
  const resourcesQ = useProjectResources(objective.projectId);
  const [showActiveConfirm, setShowActiveConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const primaryConnection = primaryResourceConnection(resourcesQ.data ?? []);
  const isQueued = Boolean(activeRequest);
  const isLaunching = launch.isPending;
  const isDisabled = !selectionLoaded || isLaunching || !primaryConnection.connected;
  const styles = sizeStyles[size];

  function queueLaunch() {
    if (!primaryConnection.connected) {
      setError(primaryConnection.message);
      return;
    }
    setError(null);
    launch.mutate(
      {
        id: objective.id,
        body: {
          agent: selection.agent,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort
        }
      },
      { onError: err => setError(err instanceof Error ? err.message : 'Failed to queue execution') }
    );
  }

  function handleRun() {
    if (isDisabled) return;
    if (hasActiveSibling) {
      setShowActiveConfirm(true);
      return;
    }
    queueLaunch();
  }

  async function handleCopyPrompt() {
    setError(null);
    try {
      const { prompt } = await api.getObjectivePrompt(objective.id);
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy prompt');
    }
  }

  const runButton = (
    <button
      type="button"
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-l-md transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        styles.runButton,
        isDisabled && 'cursor-not-allowed opacity-60'
      )}
      onClick={handleRun}
      disabled={isDisabled}
    >
      {isLaunching ? (
        <Loader2 className={cn(styles.icon, 'animate-spin')} />
      ) : isQueued ? (
        <Check className={cn(styles.icon, 'text-sky-500')} />
      ) : (
        <Bot className={styles.icon} />
      )}
      <span
        className={cn(
          'whitespace-nowrap transition-colors',
          styles.label,
          isQueued && 'text-sky-600 dark:text-sky-400'
        )}
      >
        {isQueued ? 'Queued' : 'Run'}
      </span>
    </button>
  );

  const runButtonWrapped = hasActiveSibling ? (
    <Popover open={showActiveConfirm} onOpenChange={setShowActiveConfirm}>
      <PopoverTrigger render={<span className="inline-flex">{runButton}</span>} />
      <PopoverContent side="top" className="w-80 p-3 text-sm">
        <p className="mb-3 text-foreground">
          An agent appears to be working this ticket already. Queue this objective so a runner
          launches it after the current one completes?
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => setShowActiveConfirm(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
            onClick={() => {
              setShowActiveConfirm(false);
              queueLaunch();
            }}
          >
            Queue
          </button>
        </div>
      </PopoverContent>
    </Popover>
  ) : (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn('inline-flex', isDisabled && 'cursor-not-allowed')}>{runButton}</span>
        }
      />
      <TooltipContent side="top" hidden={!isDisabled || primaryConnection.connected}>
        {!selectionLoaded
          ? 'Loading your agent model selection.'
          : !primaryConnection.connected
            ? primaryConnection.message
            : 'Queueing…'}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <div className="flex flex-col items-end gap-1">
      {!primaryConnection.connected && selectionLoaded ? (
        <div
          role="alert"
          className="flex max-w-[280px] items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-right text-[11px] text-amber-800 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <p>{primaryConnection.message}</p>
        </div>
      ) : null}
      <div
        className={cn(
          'inline-flex items-stretch rounded-md border border-input bg-background text-sm shadow-sm transition-all',
          !isDisabled && 'hover:bg-accent hover:text-accent-foreground',
          isQueued && 'border-sky-400/60 ring-1 ring-sky-400/40'
        )}
      >
        {runButtonWrapped}

        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={isDisabled}
            className={cn(
              'inline-flex items-center rounded-r-md border-l transition-colors',
              !isDisabled && 'cursor-pointer hover:bg-accent hover:text-accent-foreground',
              isDisabled && 'cursor-not-allowed',
              styles.caretButton
            )}
          >
            <ChevronDown className={cn(styles.chevron, 'text-muted-foreground')} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[180px]">
            <DropdownMenuItem className="gap-2 text-xs" onClick={handleRun}>
              <Bot className="h-3.5 w-3.5" />
              <span>Run</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2 text-xs" onClick={() => void handleCopyPrompt()}>
              <Copy className="h-3.5 w-3.5" />
              <span>{copied ? 'Copied ✓' : 'Copy prompt'}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error ? <p className="max-w-[260px] text-right text-[11px] text-red-400">{error}</p> : null}
    </div>
  );
}
