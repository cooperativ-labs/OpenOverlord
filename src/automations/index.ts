export type {
  AutoAdvanceDecision,
  EnsureDraftSlotPlan,
  ManageObjectiveLifecycleInput,
  ManageObjectiveLifecycleOutput,
  ObjectiveLifecycleObjective,
  ObjectiveLifecycleState,
  ObjectiveLifecycleView,
  ObjectiveLifecycleViolation
} from './objective-manager/index.js';
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
  manageObjectiveLifecycle,
  manageObjectiveLifecycleTool,
  OBJECTIVE_LIFECYCLE_STATES,
  objectiveHasInstructionText,
  objectiveInstructionText,
  planEnsureDraftSlot,
  sortObjectivesByLifecycleOrder,
  validateObjectiveLifecycle
} from './objective-manager/index.js';
export type { RegisteredAutomation } from './registry.js';
export {
  getAutomation,
  listAutomations,
  registerAutomation,
  registerTypedAutomation
} from './registry.js';
export type {
  GeminiConfig,
  GenerateAndSetObjectiveTitleParams,
  GenerateObjectiveTitleParams,
  ObjectiveTitleStore,
  SummarizeObjectiveTitleInput,
  SummarizeTextInput
} from './title-summarizer/index.js';
export {
  AI_TITLE_THRESHOLD,
  DEFAULT_GEMINI_MODEL,
  deriveTitleFromInstructionText,
  generateAndSetObjectiveTitle,
  generateGeminiText,
  generateObjectiveTitle,
  getGeminiClient,
  isGeminiConfigured,
  normalizeInstructionText,
  OBJECTIVE_TITLE_MAX_LENGTH,
  readGeminiConfigFromEnv,
  resetGeminiClientForTests,
  summarizeObjectiveTitleTool,
  summarizeObjectiveTitleWithGemini,
  summarizeTextTool,
  summarizeTextWithGemini
} from './title-summarizer/index.js';
export type { Automation, AutomationRunContext } from './types.js';
