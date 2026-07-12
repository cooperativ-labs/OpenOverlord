import { Monitor } from 'lucide-react';
import { useState } from 'react';

import { useProjectRepositoryContext } from '@/components/projects/ProjectRepositoryContext.tsx';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
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

function ExecutionTargetOption({ target }: { target: EligibleExecutionTargetDto }) {
  const statusSuffix = executionTargetOptionStatusSuffix(target).trim();
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{executionTargetOptionLabel(target)}</span>
        <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {target.type}
        </span>
        {statusSuffix ? (
          <span className="shrink-0 text-xs text-muted-foreground">{statusSuffix}</span>
        ) : null}
      </span>
      <span className="truncate font-mono text-[10px] text-muted-foreground">
        {target.executionTargetId}
      </span>
    </span>
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

  if (eligibleTargets.length === 0) {
    return null;
  }

  const selectorValue = resolveExecutionTargetSelectorValue({
    selectedExecutionTargetId,
    eligibleTargets
  });

  const selectedTarget = eligibleTargets.find(target => target.executionTargetId === selectorValue);
  const triggerLabel =
    selectorValue === ANY_ELIGIBLE_EXECUTION_TARGET_VALUE
      ? 'Any eligible target'
      : selectedTarget
        ? executionTargetOptionLabel(selectedTarget)
        : null;

  function handleChange(value: string | null) {
    if (!value || value === selectorValue) return;
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
    <Tooltip>
      <TooltipTrigger
        render={
          <div className={cn('flex shrink-0 items-center gap-1.5', className)}>
            <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <Label htmlFor={selectId} className="sr-only">
              Execution target
            </Label>
            <Select
              value={selectorValue}
              disabled={isRepositoryLoading || updateExecutionTarget.isPending}
              onValueChange={handleChange}
            >
              <SelectTrigger
                id={selectId}
                className="h-7 max-w-52"
                aria-invalid={error ? true : undefined}
              >
                <SelectValue placeholder="Execution target">{triggerLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {eligibleTargets.length > 1 ? (
                  <SelectItem value={ANY_ELIGIBLE_EXECUTION_TARGET_VALUE}>
                    Any eligible target
                  </SelectItem>
                ) : null}
                {eligibleTargets.map(target => (
                  <SelectItem
                    key={target.executionTargetId}
                    value={target.executionTargetId}
                    disabled={!target.reachable || !target.primaryResourceConnected}
                  >
                    <ExecutionTargetOption target={target} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <TooltipContent side="bottom" className="max-w-xs">
        {error ??
          'Choose which device runs agents for this project. Leave as any eligible target to let an online device claim work.'}
      </TooltipContent>
    </Tooltip>
  );
}
