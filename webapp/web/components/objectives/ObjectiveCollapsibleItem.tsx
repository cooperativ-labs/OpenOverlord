import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FastForward,
  Loader2
} from 'lucide-react';
import { useState } from 'react';

import type { ObjectiveDto } from '../../../shared/contract.ts';
import { useCopyToClipboard } from '../../lib/hooks/use-copy-to-clipboard.ts';
import { useUpdateObjective } from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';
import { InlineEditField } from '../InlineEditField.tsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.tsx';

import { ObjectiveMenuButton } from './ObjectiveMenuButton.tsx';

/**
 * A collapsed, read-first view of an objective that has left the editable
 * stages (executing, pending delivery, or complete). The header summarises the
 * objective with a state icon, title, and a kebab actions menu
 * ({@link ObjectiveMenuButton}); expanding it reveals the full instruction
 * text. In-flight objectives (executing / pending delivery) carry a shimmer
 * sweep so live work is visible at a glance.
 */
export function ObjectiveCollapsibleItem({
  objective,
  index
}: {
  objective: ObjectiveDto;
  index: number;
}) {
  const update = useUpdateObjective();
  const { copied, copy } = useCopyToClipboard();
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
          <div className="pointer-events-none absolute inset-0 animate-[shimmer_2s_linear_infinite] bg-[length:200%_100%] bg-linear-to-r from-transparent via-emerald-500/20 to-transparent" />
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
          {objective.externalSessionId ? (
            <button
              type="button"
              aria-label="Copy agent session"
              title="Copy agent session ID"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              onClick={async event => {
                event.preventDefault();
                event.stopPropagation();
                await copy(objective.externalSessionId ?? '');
              }}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          <ObjectiveMenuButton objectiveId={objective.id} state={objective.state} />
        </div>
        <CollapsibleContent className="border-b px-3 pb-2 pt-1">
          {objective.externalSessionId ? (
            <p className="mb-2 truncate font-mono text-[11px] text-muted-foreground/80">
              Agent session: {objective.externalSessionId}
            </p>
          ) : null}
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
