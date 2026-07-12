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
                <SelectValue placeholder="Execution target" />
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
                    {executionTargetOptionLabel(target)}
                    {executionTargetOptionStatusSuffix(target)}
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
