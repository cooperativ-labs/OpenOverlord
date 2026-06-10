export {
  DEFAULT_GEMINI_MODEL,
  isGeminiConfigured,
  readGeminiConfigFromEnv,
  generateGeminiText,
  getGeminiClient,
  resetGeminiClientForTests,
  deriveTitleFromInstructionText,
  normalizeInstructionText,
  generateAndSetObjectiveTitle,
  generateObjectiveTitle,
  AI_TITLE_THRESHOLD,
  OBJECTIVE_TITLE_MAX_LENGTH,
  summarizeObjectiveTitleTool,
  summarizeObjectiveTitleWithGemini,
  summarizeTextTool,
  summarizeTextWithGemini
} from './title-summarizer/index.js';
export type {
  GeminiConfig,
  GenerateAndSetObjectiveTitleParams,
  GenerateObjectiveTitleParams,
  ObjectiveTitleStore,
  SummarizeObjectiveTitleInput,
  SummarizeTextInput
} from './title-summarizer/index.js';
export {
  getAutomation,
  listAutomations,
  registerAutomation,
  registerTypedAutomation
} from './registry.js';
export type { RegisteredAutomation } from './registry.js';
export type { Automation, AutomationRunContext } from './types.js';
