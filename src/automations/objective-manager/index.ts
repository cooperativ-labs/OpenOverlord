import type { Automation } from '../types.js';

import {
  type AutoAdvanceDecision,
  decideAutoAdvanceAfterDelivery,
  deriveObjectiveLifecycleView,
  type EnsureDraftSlotPlan,
  type ObjectiveLifecycleObjective,
  type ObjectiveLifecycleViolation,
  planEnsureDraftSlot
} from './rules.js';

export type {
  AutoAdvanceDecision,
  EnsureDraftSlotPlan,
  ObjectiveLifecycleObjective,
  ObjectiveLifecycleState,
  ObjectiveLifecycleView,
  ObjectiveLifecycleViolation
} from './rules.js';
export {
  ACTIVE_OBJECTIVE_STATES,
  AUTO_ADVANCE_TOGGLE_OBJECTIVE_STATES,
  canEditObjectiveInstruction,
  canToggleObjectiveAutoAdvance,
  decideAutoAdvanceAfterDelivery,
  deriveObjectiveLifecycleView,
  EDITABLE_NEXT_UP_OBJECTIVE_STATES,
  FUTURE_OBJECTIVE_STATES,
  isActiveObjective,
  isEditableNextUpObjective,
  isFutureObjective,
  isLaunchableObjective,
  LAUNCHABLE_OBJECTIVE_STATES,
  OBJECTIVE_LIFECYCLE_STATES,
  objectiveHasInstructionText,
  objectiveInstructionText,
  planEnsureDraftSlot,
  sortObjectivesByLifecycleOrder,
  validateObjectiveLifecycle
} from './rules.js';

export type ManageObjectiveLifecycleInput = {
  objectives: ObjectiveLifecycleObjective[];
  ticket?: {
    humanOnly?: boolean;
  };
  ensureDraftSlot?: {
    previousObjectiveId?: string;
    assignedAgent?: string | null;
  };
  planAutoAdvance?: boolean;
};

export type ManageObjectiveLifecycleOutput = {
  orderedObjectiveIds: string[];
  executedObjectiveIds: string[];
  editableObjectiveIds: string[];
  futureObjectiveIds: string[];
  activeObjectiveId: string | null;
  nextUpObjectiveId: string | null;
  hasNonExecuted: boolean;
  violations: ObjectiveLifecycleViolation[];
  ensureDraftSlotPlan: EnsureDraftSlotPlan;
  autoAdvanceDecision: AutoAdvanceDecision | null;
};

export function manageObjectiveLifecycle(
  input: ManageObjectiveLifecycleInput
): ManageObjectiveLifecycleOutput {
  const view = deriveObjectiveLifecycleView(input.objectives);
  const autoAdvanceOptions =
    input.ticket?.humanOnly === undefined ? {} : { humanOnly: input.ticket.humanOnly };

  return {
    orderedObjectiveIds: view.orderedObjectives.map(objective => objective.id),
    executedObjectiveIds: view.executedObjectives.map(objective => objective.id),
    editableObjectiveIds: view.editableObjectives.map(objective => objective.id),
    futureObjectiveIds: view.futureObjectives.map(objective => objective.id),
    activeObjectiveId: view.activeObjective?.id ?? null,
    nextUpObjectiveId: view.nextUpObjective?.id ?? null,
    hasNonExecuted: view.hasNonExecuted,
    violations: view.violations,
    ensureDraftSlotPlan: planEnsureDraftSlot(input.objectives, input.ensureDraftSlot),
    autoAdvanceDecision: input.planAutoAdvance
      ? decideAutoAdvanceAfterDelivery(input.objectives, autoAdvanceOptions)
      : null
  };
}

export const manageObjectiveLifecycleTool: Automation<
  ManageObjectiveLifecycleInput,
  ManageObjectiveLifecycleOutput
> = {
  id: 'manage-objective-lifecycle',
  label: 'Manage objective lifecycle',
  description:
    'Applies the objective lifecycle ruleset to classify objectives, validate invariants, and plan refill or auto-advance actions without writing persistence.',
  run: async ({ input }) => manageObjectiveLifecycle(input)
};
