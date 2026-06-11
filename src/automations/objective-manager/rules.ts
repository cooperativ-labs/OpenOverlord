export type ObjectiveLifecycleState =
  | 'future'
  | 'draft'
  | 'submitted'
  | 'launching'
  | 'executing'
  | 'pending_delivery'
  | 'complete';

export type ObjectiveLifecycleObjective = {
  id: string;
  position: number;
  state: ObjectiveLifecycleState | string;
  instructionText?: string;
  objective?: string;
  autoAdvance?: boolean;
  assignedAgent?: string | null;
  createdAt?: string;
};

export type ObjectiveLifecycleViolation = {
  code:
    | 'multiple_drafts'
    | 'multiple_active_objectives'
    | 'duplicate_position'
    | 'blank_instruction_after_draft';
  objectiveIds: string[];
  message: string;
};

export type EnsureDraftSlotPlan =
  | { action: 'none'; reason: 'draft_slot_filled' | 'next_up_still_launching' }
  | { action: 'promote_future'; objectiveId: string }
  | { action: 'create_blank_draft'; assignedAgent: string | null };

export type AutoAdvanceDecision =
  | { action: 'none'; reason: 'no_non_empty_draft' | 'human_only_ticket' }
  | { action: 'await_approval'; objectiveId: string; reason: string }
  | { action: 'queue_launch'; objectiveId: string; idempotencyKey: string };

export type ObjectiveLifecycleView<TObjective extends ObjectiveLifecycleObjective> = {
  orderedObjectives: TObjective[];
  executedObjectives: TObjective[];
  editableObjectives: TObjective[];
  futureObjectives: TObjective[];
  activeObjective: TObjective | null;
  nextUpObjective: TObjective | null;
  hasNonExecuted: boolean;
  violations: ObjectiveLifecycleViolation[];
};

export const OBJECTIVE_LIFECYCLE_STATES = [
  'future',
  'draft',
  'submitted',
  'launching',
  'executing',
  'pending_delivery',
  'complete'
] as const satisfies readonly ObjectiveLifecycleState[];

export const EDITABLE_NEXT_UP_OBJECTIVE_STATES = [
  'draft',
  'submitted',
  'launching'
] as const satisfies readonly ObjectiveLifecycleState[];

export const FUTURE_OBJECTIVE_STATES = [
  'future'
] as const satisfies readonly ObjectiveLifecycleState[];

export const ACTIVE_OBJECTIVE_STATES = [
  'executing',
  'pending_delivery'
] as const satisfies readonly ObjectiveLifecycleState[];

export const LAUNCHABLE_OBJECTIVE_STATES = [
  'draft',
  'submitted',
  'launching'
] as const satisfies readonly ObjectiveLifecycleState[];

export const AUTO_ADVANCE_TOGGLE_OBJECTIVE_STATES = [
  'future',
  'draft',
  'submitted',
  'launching'
] as const satisfies readonly ObjectiveLifecycleState[];

const NON_EMPTY_INSTRUCTION_STATES = new Set([
  'submitted',
  'launching',
  'executing',
  'pending_delivery',
  'complete'
]);

function stateIn(
  state: string,
  states: readonly ObjectiveLifecycleState[]
): state is ObjectiveLifecycleState {
  return (states as readonly string[]).includes(state);
}

export function objectiveInstructionText(objective: ObjectiveLifecycleObjective): string {
  return objective.instructionText ?? objective.objective ?? '';
}

export function objectiveHasInstructionText(objective: ObjectiveLifecycleObjective): boolean {
  return objectiveInstructionText(objective).trim().length > 0;
}

export function isEditableNextUpObjective(objective: ObjectiveLifecycleObjective): boolean {
  return stateIn(objective.state, EDITABLE_NEXT_UP_OBJECTIVE_STATES);
}

export function isFutureObjective(objective: ObjectiveLifecycleObjective): boolean {
  return stateIn(objective.state, FUTURE_OBJECTIVE_STATES);
}

export function isActiveObjective(objective: ObjectiveLifecycleObjective): boolean {
  return stateIn(objective.state, ACTIVE_OBJECTIVE_STATES);
}

export function isLaunchableObjective(objective: ObjectiveLifecycleObjective): boolean {
  return stateIn(objective.state, LAUNCHABLE_OBJECTIVE_STATES);
}

export function canToggleObjectiveAutoAdvance(objective: ObjectiveLifecycleObjective): boolean {
  return stateIn(objective.state, AUTO_ADVANCE_TOGGLE_OBJECTIVE_STATES);
}

export function canEditObjectiveInstruction(objective: ObjectiveLifecycleObjective): boolean {
  return (
    isFutureObjective(objective) ||
    objective.state === 'draft' ||
    objective.state === 'submitted' ||
    objective.state === 'launching'
  );
}

export function sortObjectivesByLifecycleOrder<TObjective extends ObjectiveLifecycleObjective>(
  objectives: readonly TObjective[]
): TObjective[] {
  return [...objectives].sort((a, b) => {
    const byPosition = a.position - b.position;
    if (byPosition !== 0) return byPosition;
    const byCreatedAt = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
    if (byCreatedAt !== 0) return byCreatedAt;
    return a.id.localeCompare(b.id);
  });
}

export function validateObjectiveLifecycle(
  objectives: readonly ObjectiveLifecycleObjective[]
): ObjectiveLifecycleViolation[] {
  const ordered = sortObjectivesByLifecycleOrder(objectives);
  const violations: ObjectiveLifecycleViolation[] = [];

  const drafts = ordered.filter(o => o.state === 'draft');
  if (drafts.length > 1) {
    violations.push({
      code: 'multiple_drafts',
      objectiveIds: drafts.map(o => o.id),
      message: 'A ticket may have at most one draft objective.'
    });
  }

  const active = ordered.filter(isActiveObjective);
  if (active.length > 1) {
    violations.push({
      code: 'multiple_active_objectives',
      objectiveIds: active.map(o => o.id),
      message: 'A ticket may have at most one executing or pending-delivery objective.'
    });
  }

  const byPosition = new Map<number, ObjectiveLifecycleObjective[]>();
  for (const objective of ordered) {
    byPosition.set(objective.position, [...(byPosition.get(objective.position) ?? []), objective]);
  }
  for (const duplicates of byPosition.values()) {
    if (duplicates.length <= 1) continue;
    violations.push({
      code: 'duplicate_position',
      objectiveIds: duplicates.map(o => o.id),
      message: `Objectives share position ${duplicates[0]?.position ?? 'unknown'}.`
    });
  }

  const blankAfterDraft = ordered.filter(
    objective =>
      NON_EMPTY_INSTRUCTION_STATES.has(objective.state) && !objectiveHasInstructionText(objective)
  );
  if (blankAfterDraft.length > 0) {
    violations.push({
      code: 'blank_instruction_after_draft',
      objectiveIds: blankAfterDraft.map(o => o.id),
      message: 'Submitted, launching, active, and complete objectives require instruction text.'
    });
  }

  return violations;
}

export function deriveObjectiveLifecycleView<TObjective extends ObjectiveLifecycleObjective>(
  objectives: readonly TObjective[]
): ObjectiveLifecycleView<TObjective> {
  const orderedObjectives = sortObjectivesByLifecycleOrder(objectives);
  const executedObjectives = orderedObjectives.filter(
    objective =>
      (isActiveObjective(objective) || objective.state === 'complete') &&
      objectiveHasInstructionText(objective)
  );
  const editableObjectives = orderedObjectives.filter(isEditableNextUpObjective);
  const futureObjectives = orderedObjectives.filter(isFutureObjective);
  const activeObjective = orderedObjectives.find(isActiveObjective) ?? null;
  const nextUpObjective = orderedObjectives.find(isEditableNextUpObjective) ?? null;

  return {
    orderedObjectives,
    executedObjectives,
    editableObjectives,
    futureObjectives,
    activeObjective,
    nextUpObjective,
    hasNonExecuted: editableObjectives.length > 0 || futureObjectives.length > 0,
    violations: validateObjectiveLifecycle(orderedObjectives)
  };
}

export function planEnsureDraftSlot(
  objectives: readonly ObjectiveLifecycleObjective[],
  options: { previousObjectiveId?: string; assignedAgent?: string | null } = {}
): EnsureDraftSlotPlan {
  const ordered = sortObjectivesByLifecycleOrder(objectives);
  if (ordered.some(objective => objective.state === 'draft')) {
    return { action: 'none', reason: 'draft_slot_filled' };
  }
  if (
    ordered.some(objective => objective.state === 'submitted' || objective.state === 'launching')
  ) {
    return { action: 'none', reason: 'next_up_still_launching' };
  }

  const nextFuture = ordered.find(isFutureObjective);
  if (nextFuture) {
    return { action: 'promote_future', objectiveId: nextFuture.id };
  }

  const previousObjective = options.previousObjectiveId
    ? ordered.find(objective => objective.id === options.previousObjectiveId)
    : null;
  const inheritedAgent =
    options.assignedAgent ??
    previousObjective?.assignedAgent ??
    [...ordered].reverse().find(objective => objective.assignedAgent)?.assignedAgent ??
    null;

  return { action: 'create_blank_draft', assignedAgent: inheritedAgent };
}

export function decideAutoAdvanceAfterDelivery(
  objectives: readonly ObjectiveLifecycleObjective[],
  options: { humanOnly?: boolean; defaultApprovalReason?: string } = {}
): AutoAdvanceDecision {
  const nextDraft = sortObjectivesByLifecycleOrder(objectives).find(
    objective => objective.state === 'draft' && objectiveHasInstructionText(objective)
  );

  if (!nextDraft) {
    return { action: 'none', reason: 'no_non_empty_draft' };
  }
  if (options.humanOnly) {
    return { action: 'none', reason: 'human_only_ticket' };
  }
  if (!nextDraft.autoAdvance) {
    return {
      action: 'await_approval',
      objectiveId: nextDraft.id,
      reason: options.defaultApprovalReason ?? 'Next objective is waiting for approval.'
    };
  }
  if (!nextDraft.assignedAgent) {
    return {
      action: 'await_approval',
      objectiveId: nextDraft.id,
      reason: 'Auto-advance requires an assigned agent.'
    };
  }

  return {
    action: 'queue_launch',
    objectiveId: nextDraft.id,
    idempotencyKey: `auto_advance:${nextDraft.id}`
  };
}
