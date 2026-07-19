export type {
  ComposeDeliveryDraft,
  ComposeDeliveryEvidenceItem,
  ComposeDeliveryInput
} from './compose-delivery/index.js';
export {
  buildComposeDeliveryPrompt,
  COMPOSE_DELIVERY_RESPONSE_SCHEMA,
  composeDeliveryTool,
  composeDeliveryWithGemini,
  resetGeminiClientForTests as resetComposeDeliveryGeminiClientForTests
} from './compose-delivery/index.js';
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
  loadExternalAutomations,
  registerAutomation,
  registerAutomations,
  registerTypedAutomation
} from './registry.js';
export type {
  NormalizedSchedule,
  PeriodType,
  ScheduleLike,
  WeekDayType
} from './scheduling-engine/index.js';
export {
  generateDateFromFailureRepeatSeconds,
  generateDateFromSchedule
} from './scheduling-engine/index.js';
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
