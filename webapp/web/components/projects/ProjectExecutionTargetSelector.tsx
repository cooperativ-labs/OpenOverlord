import { Check, ChevronsUpDown, Monitor } from 'lucide-react';
import { useState } from 'react';

import { useProjectRepositoryContext } from '@/components/projects/ProjectRepositoryContext.tsx';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ANY_ELIGIBLE_EXECUTION_TARGET_VALUE,
  executionTargetOptionLabel,
  executionTargetOptionStatusSuffix,
  parseExecutionTargetSelectorValue,
  resolveExecutionTargetSelectorValue
} from '@/lib/execution-target-selection';
import { useUpdateProjectExecutionTarget } from '@/lib/queries';
import { cn } from '@/lib/utils';

import type { EligibleExecutionTargetDto } from '../../../shared/contract.ts';

function TargetTypeBadge({ type }: { type: string }) {
  return (
    <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {type}
    </span>
  );
}

function ExecutionTargetOptionRow({
  target,
  selected,
  disabled,
  onSelect
}: {
  target: EligibleExecutionTargetDto;
  selected: boolean;
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  const statusSuffix = executionTargetOptionStatusSuffix(target).trim();
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={() => onSelect(target.executionTargetId)}
      className={cn(
        'flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
        disabled && 'pointer-events-none opacity-50',
        selected && 'bg-muted/60'
      )}
    >
      <Check
        className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-primary', !selected && 'opacity-0')}
        aria-hidden
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{executionTargetOptionLabel(target)}</span>
          <TargetTypeBadge type={target.type} />
          {statusSuffix ? (
            <span className="shrink-0 text-xs text-muted-foreground">{statusSuffix}</span>
          ) : null}
        </span>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {target.executionTargetId}
        </span>
      </span>
    </button>
  );
}

type ProjectExecutionTargetSelectorProps = {
  projectId: string;
  selectId?: string;
  className?: string;
};

export function ProjectExecutionTargetSelector({
  projectId,
  selectId = 'project-execution-target',
  className
}: ProjectExecutionTargetSelectorProps) {
  const updateExecutionTarget = useUpdateProjectExecutionTarget(projectId);
  const {
    eligibleTargets,
    isLoading: isRepositoryLoading,
    selectedExecutionTargetId
  } = useProjectRepositoryContext();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (eligibleTargets.length === 0) {
    return null;
  }

  const selectorValue = resolveExecutionTargetSelectorValue({
    selectedExecutionTargetId,
    eligibleTargets
  });

  const isAny = selectorValue === ANY_ELIGIBLE_EXECUTION_TARGET_VALUE;
  const selectedTarget = eligibleTargets.find(target => target.executionTargetId === selectorValue);
  const triggerLabel = isAny
    ? 'Any eligible target'
    : selectedTarget
      ? executionTargetOptionLabel(selectedTarget)
      : 'Execution target';

  const disabled = isRepositoryLoading || updateExecutionTarget.isPending;
  const showAnyOption = eligibleTargets.length > 1;

  function handleChange(value: string) {
    setOpen(false);
    if (value === selectorValue) return;
    setError(null);
    updateExecutionTarget.mutate(
      { executionTargetId: parseExecutionTargetSelectorValue(value) },
      {
        onError: mutationError => {
          setError(
            mutationError instanceof Error
              ? mutationError.message
              : 'Failed to update execution target.'
          );
        }
      }
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn('flex shrink-0 items-center gap-1.5', className)}>
        <Label htmlFor={selectId} className="sr-only">
          Execution target
        </Label>
        <Tooltip open={open ? false : undefined}>
          <TooltipTrigger
            render={
              <PopoverTrigger
                id={selectId}
                disabled={disabled}
                aria-invalid={error ? true : undefined}
                className={cn(
                  'group flex h-7 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-background px-2 text-sm font-medium shadow-xs transition-colors',
                  'hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                  'aria-expanded:bg-muted disabled:pointer-events-none disabled:opacity-50',
                  'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20',
                  'dark:border-input dark:bg-input/30 dark:hover:bg-input/50'
                )}
              >
                <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
                {!isAny && selectedTarget ? <TargetTypeBadge type={selectedTarget.type} /> : null}
                <ChevronsUpDown
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-70"
                  aria-hidden
                />
              </PopoverTrigger>
            }
          />
          <TooltipContent side="bottom" className="max-w-xs">
            {error ??
              'Choose which device runs agents for this project. Leave as any eligible target to let an online device claim work.'}
          </TooltipContent>
        </Tooltip>
      </div>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-72 max-w-[min(20rem,calc(100vw-2rem))] p-1"
        role="listbox"
      >
        {showAnyOption ? (
          <button
            type="button"
            role="option"
            aria-selected={isAny}
            onClick={() => handleChange(ANY_ELIGIBLE_EXECUTION_TARGET_VALUE)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              'hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
              isAny && 'bg-muted/60'
            )}
          >
            <Check
              className={cn('h-3.5 w-3.5 shrink-0 text-primary', !isAny && 'opacity-0')}
              aria-hidden
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">Any eligible target</span>
              <span className="truncate text-[10px] text-muted-foreground">
                Let any online device claim work
              </span>
            </span>
          </button>
        ) : null}
        {showAnyOption ? <div className="my-1 h-px bg-border" /> : null}
        {eligibleTargets.map(target => (
          <ExecutionTargetOptionRow
            key={target.executionTargetId}
            target={target}
            selected={!isAny && target.executionTargetId === selectorValue}
            disabled={!target.reachable || !target.primaryResourceConnected}
            onSelect={handleChange}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
