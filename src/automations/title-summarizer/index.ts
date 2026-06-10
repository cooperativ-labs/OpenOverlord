export type { GeminiConfig } from './config.js';
export { DEFAULT_GEMINI_MODEL, isGeminiConfigured, readGeminiConfigFromEnv } from './config.js';
export { generateGeminiText, getGeminiClient, resetGeminiClientForTests } from './gemini-client.js';
export { deriveTitleFromInstructionText, normalizeInstructionText } from './helpers/title.js';
export type {
  GenerateAndSetObjectiveTitleParams,
  GenerateObjectiveTitleParams,
  ObjectiveTitleStore
} from './objectives/generate-objective-title.js';
export {
  generateAndSetObjectiveTitle,
  generateObjectiveTitle
} from './objectives/generate-objective-title.js';
export type { SummarizeObjectiveTitleInput } from './tools/summarize-objective-title.js';
export {
  AI_TITLE_THRESHOLD,
  OBJECTIVE_TITLE_MAX_LENGTH,
  summarizeObjectiveTitleTool,
  summarizeObjectiveTitleWithGemini
} from './tools/summarize-objective-title.js';
export type { SummarizeTextInput } from './tools/summarize-text.js';
export { summarizeTextTool, summarizeTextWithGemini } from './tools/summarize-text.js';
