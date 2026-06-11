import {
  ArrowUpCircle,
  Check,
  ChevronUp,
  FastForward,
  Loader2,
  PauseCircle,
  X
} from 'lucide-react';
import { useState } from 'react';

import type {
  ExecutionRequestDto,
  ObjectiveDto,
  ObjectiveState
} from '../../../shared/contract.ts';
import { useDeleteObjective, useUpdateObjective } from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';
import {
  Badge,
  Button,
  EditableText,
  OBJECTIVE_STATE_LABEL,
  objectiveStateClasses
} from '../ui.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Switch } from '../ui/switch.tsx';

import { AgentLaunchButton } from './AgentLaunchButton.tsx';
import { AgentModelChooserButton } from './AgentModelChooserButton.tsx';
import { useObjectiveAgentSelection } from './useObjectiveAgentSelection.ts';

const AUTO_ADVANCE_TOGGLE_STATES: ObjectiveState[] = ['future', 'draft', 'submitted', 'launching'];
const ACTIVE_SIBLING_STATES: ObjectiveState[] = ['launching', 'executing', 'pending_delivery'];
const OBJECTIVE_STATES: ObjectiveState[] = [
  'future',
  'draft',
  'submitted',
  'launching',
  'executing',
  'pending_delivery',
  'complete'
];

type DraftObjectiveProps = {
  objective: ObjectiveDto;
  /** All objectives on the ticket — used to detect an already-active sibling. */
  siblings: ObjectiveDto[];
  /** Active execution requests for the ticket (from TicketDetailDto). */
  executionRequests: ExecutionRequestDto[];
};

/**
 * One objective card with the launch surface: state-aware styling, inline
 * instruction editing, auto-advance toggle, agent/model chooser, and the
 * split run button (or Promote for `future` objectives).
 */
export function DraftObjective({ objective, siblings, executionRequests }: DraftObjectiveProps) {
  const update = useUpdateObjective();
  const remove = useDeleteObjective();
  const { catalog, agentConfigs, selection, setSelection, commitLaunchConfig, loaded } =
    useObjectiveAgentSelection(objective);
  const [isFutureExpanded, setIsFutureExpanded] = useState(false);

  const isFuture = objective.state === 'future';
  // `launching` is the pre-attach state; render it like `submitted`.
  const isSubmitted = objective.state === 'submitted' || objective.state === 'launching';
  const isLaunchable = objective.state === 'draft' || isSubmitted;
  const canToggleAutoAdvance = AUTO_ADVANCE_TOGGLE_STATES.includes(objective.state);
  const hasActiveSibling = siblings.some(
    o => o.id !== objective.id && ACTIVE_SIBLING_STATES.includes(o.state)
  );
  const activeRequest = executionRequests.find(r => r.objectiveId === objective.id) ?? null;
  const autoAdvancePending =
    update.isPending && update.variables?.id === objective.id
      ? update.variables.body.autoAdvance !== undefined
      : false;

  function handlePromote() {
    update.mutate({ id: objective.id, body: { state: 'draft' } });
  }

  return (
    <div
      className={cn(
        'relative w-full overflow-hidden rounded-xl border transition-all focus-within:ring-1 focus-within:ring-ring/50',
        isFuture
          ? 'border-border/50 bg-muted/20 opacity-70 focus-within:opacity-100'
          : 'border-muted-foreground/20',
        isSubmitted && 'border-sky-400/45 bg-sky-500/5 focus-within:ring-sky-400/30'
      )}
      onFocusCapture={() => {
        if (isFuture) setIsFutureExpanded(true);
      }}
    >
      {/* Header: position, title, state, delete */}
      <div className="flex items-start justify-between gap-3 px-3 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            #{objective.position + 1}
          </span>
          <span className="truncate text-sm font-medium">
            <EditableText
              value={objective.title ?? ''}
              placeholder="Untitled objective"
              onSave={title => update.mutate({ id: objective.id, body: { title } })}
            />
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              className="cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              title="Change state"
            >
              <Badge className={objectiveStateClasses(objective.state)}>
                {OBJECTIVE_STATE_LABEL[objective.state]}
              </Badge>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[160px]">
              {OBJECTIVE_STATES.map(s => (
                <DropdownMenuItem
                  key={s}
                  className="gap-2 text-xs"
                  onClick={() => update.mutate({ id: objective.id, body: { state: s } })}
                >
                  <span>{OBJECTIVE_STATE_LABEL[s]}</span>
                  {s === objective.state && (
                    <Check className="ml-auto h-3 w-3 text-muted-foreground" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            aria-label="Delete objective"
            onClick={() => {
              if (confirm('Delete this objective?')) remove.mutate(objective.id);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Instruction body — future objectives collapse until focused */}
      <div
        className={cn(
          'relative px-3 py-2 transition-[max-height] duration-200 ease-in-out',
          isFuture && !isFutureExpanded && 'max-h-[3.25rem] overflow-hidden',
          isFuture && isFutureExpanded && 'max-h-[500px] overflow-y-auto'
        )}
      >
        <div className={cn('text-sm leading-relaxed', isFuture && 'text-muted-foreground')}>
          <EditableText
            multiline
            value={objective.instructionText}
            className="block whitespace-pre-wrap"
            inputClassName="text-sm"
            onSave={instructionText =>
              update.mutate({ id: objective.id, body: { instructionText } })
            }
          />
        </div>
        {isFuture && isFutureExpanded ? (
          <button
            type="button"
            className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-border/50 bg-background/90 text-muted-foreground shadow-sm hover:bg-background hover:text-foreground"
            aria-label="Collapse objective"
            onClick={() => {
              setIsFutureExpanded(false);
              (document.activeElement as HTMLElement | null)?.blur();
            }}
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {isFuture && !isFutureExpanded ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background/80 to-transparent" />
        ) : null}
      </div>

      {/* Toolbar: auto-advance, agent/model chooser, run / promote */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/40 px-3 py-2">
        {canToggleAutoAdvance ? (
          <Popover>
            <PopoverTrigger
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors hover:bg-accent',
                objective.autoAdvance ? 'text-emerald-600' : 'text-amber-600'
              )}
              aria-label={objective.autoAdvance ? 'Auto-advance on' : 'Auto-advance off'}
              title={objective.autoAdvance ? 'Auto-advance ON' : 'Auto-advance OFF'}
            >
              {autoAdvancePending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : objective.autoAdvance ? (
                <FastForward className="h-3.5 w-3.5" />
              ) : (
                <PauseCircle className="h-3.5 w-3.5" />
              )}
            </PopoverTrigger>
            <PopoverContent className="w-64" align="end">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">Auto-advance</span>
                  <Switch
                    checked={objective.autoAdvance}
                    disabled={autoAdvancePending}
                    onCheckedChange={next =>
                      update.mutate({ id: objective.id, body: { autoAdvance: next } })
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  When enabled, this objective will automatically start executing after the previous
                  one completes. When disabled, it will wait for manual approval before starting.
                </p>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}

        <div className="grow" />

        <AgentModelChooserButton
          catalog={catalog}
          selection={selection}
          onChange={setSelection}
          agentConfigs={agentConfigs}
          onLaunchConfigCommit={commitLaunchConfig}
        />

        {isFuture ? (
          <Button
            variant="secondary"
            className="h-8 gap-1.5 px-3 text-xs"
            disabled={update.isPending}
            onClick={handlePromote}
          >
            {update.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpCircle className="h-3.5 w-3.5" />
            )}
            Promote
          </Button>
        ) : isLaunchable ? (
          <AgentLaunchButton
            objective={objective}
            selection={selection}
            selectionLoaded={loaded}
            hasActiveSibling={hasActiveSibling}
            activeRequest={activeRequest}
            size="sm"
          />
        ) : null}
      </div>
    </div>
  );
}
