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
