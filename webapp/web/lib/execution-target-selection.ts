import type { EligibleExecutionTargetDto } from '../../shared/contract.ts';

export const ANY_ELIGIBLE_EXECUTION_TARGET_VALUE = '__any_eligible_target__';

export function executionTargetOptionLabel(target: EligibleExecutionTargetDto): string {
  const device = target.deviceLabel?.trim();
  const base = target.label.trim() || target.executionTargetId;
  return device && device !== base ? `${base} (${device})` : base;
}

export function executionTargetOptionStatusSuffix(target: EligibleExecutionTargetDto): string {
  if (!target.reachable) return ' (offline)';
  if (!target.primaryResourceConnected) return ' (no primary)';
  return '';
}

export function resolveExecutionTargetSelectorValue({
  selectedExecutionTargetId,
  eligibleTargets
}: {
  selectedExecutionTargetId: string | null;
  eligibleTargets: EligibleExecutionTargetDto[];
}): string {
  if (selectedExecutionTargetId) return selectedExecutionTargetId;
  if (eligibleTargets.length > 1) return ANY_ELIGIBLE_EXECUTION_TARGET_VALUE;
  return eligibleTargets[0]?.executionTargetId ?? ANY_ELIGIBLE_EXECUTION_TARGET_VALUE;
}

export function parseExecutionTargetSelectorValue(value: string): string | null {
  return value === ANY_ELIGIBLE_EXECUTION_TARGET_VALUE ? null : value;
}
