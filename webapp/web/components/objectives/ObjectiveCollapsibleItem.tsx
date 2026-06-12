import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  FastForward,
  Loader2,
  X
} from 'lucide-react';
import { useState } from 'react';

import type { ObjectiveDto, ObjectiveState } from '../../../shared/contract.ts';
import { useDeleteObjective, useUpdateObjective } from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';
import { InlineEditField } from '../InlineEditField.tsx';
import { Badge, Button, OBJECTIVE_STATE_LABEL, objectiveStateClasses } from '../ui.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu.tsx';

const OBJECTIVE_STATES: ObjectiveState[] = [
  'future',
  'draft',
  'submitted',
  'launching',
  'executing',
  'pending_delivery',
  'complete'
];

/**
 * A collapsed, read-first view of an objective that has left the editable
 * stages (executing, pending delivery, or complete). The header summarises the
 * objective with a state icon, title, and state badge; expanding it reveals the
 * full instruction text. In-flight objectives (executing / pending delivery)
 * carry a shimmer sweep so live work is visible at a glance.
 */
export function ObjectiveCollapsibleItem({
  objective,
  index
}: {
  objective: ObjectiveDto;
  index: number;
}) {
  const update = useUpdateObjective();
  const remove = useDeleteObjective();
  const [open, setOpen] = useState(false);

  const isExecuting = objective.state === 'executing';
  const isPendingDelivery = objective.state === 'pending_delivery';
  const inFlight = isExecuting || isPendingDelivery;
  const timestampLabel = isExecuting
    ? 'Executing since'
    : isPendingDelivery
      ? 'Pending delivery since'
      : 'Completed';
  const objectiveTimestamp = new Date(objective.updatedAt).toLocaleString();

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="relative overflow-hidden rounded-md">
        {inFlight ? (
          <div className="pointer-events-none absolute inset-0 -translate-x-full animate-[shimmer_2s_linear_infinite] bg-gradient-to-r from-transparent via-emerald-500/20 to-transparent" />
        ) : null}
        <div className="flex items-center gap-1 overflow-hidden rounded-md pr-1 hover:bg-muted/40">
          <CollapsibleTrigger
            className={cn(
              'relative flex min-w-0 flex-1 flex-col rounded-md py-2 pl-3 pr-1 text-left outline-none',
              !inFlight && 'hover:bg-muted/40'
            )}
          >
            <div className="flex w-full min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {isExecuting ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : isPendingDelivery ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : objective.state === 'complete' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                ) : null}
                <p
                  className="truncate text-sm font-medium"
                  title={`${timestampLabel} ${objectiveTimestamp}`}
                >
                  {objective.title ?? `Objective ${index + 1}`}
                </p>
              </div>
              <ChevronDown
                className={cn(
                  'ml-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
                  open && 'rotate-180'
                )}
              />
            </div>
            {objective.autoAdvance ? (
              <div className="mt-0.5 flex items-center gap-1 pl-[18px] text-[11px] text-muted-foreground">
                <FastForward className="h-3 w-3" />
                <span>Auto-advance</span>
              </div>
            ) : null}
          </CollapsibleTrigger>
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
        <CollapsibleContent className="border-b px-3 pb-2 pt-1">
          <div className="text-sm leading-relaxed text-muted-foreground">
            <InlineEditField
              multiline
              value={objective.instructionText}
              className="block whitespace-pre-wrap"
              ariaLabel="Objective instruction"
              onSave={instructionText =>
                update.mutate({ id: objective.id, body: { instructionText } })
              }
            />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
