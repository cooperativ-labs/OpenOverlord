import { Check, FastForward, Loader2, MoreVertical, PauseCircle, Trash2 } from 'lucide-react';

import type { ObjectiveDto, ObjectiveState } from '../../../shared/contract.ts';
import { useDeleteObjective, useUpdateObjective } from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';
import { OBJECTIVE_STATE_LABEL } from '../ui.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Switch } from '../ui/switch.tsx';

const AUTO_ADVANCE_TOGGLE_STATES: ObjectiveState[] = ['future', 'draft', 'submitted', 'launching'];
const OBJECTIVE_STATES: ObjectiveState[] = [
  'future',
  'draft',
  'submitted',
  'launching',
  'executing',
  'pending_delivery',
  'complete'
];

type DraftObjectiveActionsProps = {
  objective: ObjectiveDto;
};

/** State picker, delete, and auto-advance controls for a draft objective card. */
export function DraftObjectiveActions({ objective }: DraftObjectiveActionsProps) {
  const update = useUpdateObjective();
  const remove = useDeleteObjective();

  const canToggleAutoAdvance = AUTO_ADVANCE_TOGGLE_STATES.includes(objective.state);
  const autoAdvancePending =
    update.isPending && update.variables?.id === objective.id
      ? update.variables.body.autoAdvance !== undefined
      : false;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label="Objective actions"
          title="Objective actions"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[160px]">
          {OBJECTIVE_STATES.map(s => (
            <DropdownMenuItem
              key={s}
              className="gap-2 text-xs"
              onClick={() => update.mutate({ id: objective.id, body: { state: s } })}
            >
              <span>{OBJECTIVE_STATE_LABEL[s]}</span>
              {s === objective.state && <Check className="ml-auto h-3 w-3 text-muted-foreground" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 text-xs text-red-600 focus:text-red-600"
            onClick={() => {
              if (confirm('Delete this objective?')) remove.mutate(objective.id);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Delete objective</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
    </>
  );
}
