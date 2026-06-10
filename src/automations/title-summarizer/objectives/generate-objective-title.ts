import {
  AI_TITLE_THRESHOLD,
  summarizeObjectiveTitleWithGemini
} from '../tools/summarize-objective-title.js';
import { deriveTitleFromInstructionText } from '../helpers/title.js';

export type ObjectiveTitleStore = {
  updateObjectiveTitle: (params: { objectiveId: string; title: string }) => Promise<void>;
};

export type GenerateObjectiveTitleParams = {
  instructionText: string;
  aiTitleGenerationEnabled?: boolean;
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolves an objective title from instruction text.
 * Short text uses local truncation; longer text optionally calls Gemini.
 */
export async function generateObjectiveTitle(
  params: GenerateObjectiveTitleParams
): Promise<string> {
  const { instructionText, aiTitleGenerationEnabled = true, env } = params;
  const normalized = instructionText.trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= AI_TITLE_THRESHOLD) {
    return deriveTitleFromInstructionText(normalized);
  }

  if (aiTitleGenerationEnabled) {
    const aiTitle = await summarizeObjectiveTitleWithGemini({
      instructionText: normalized,
      ...(env ? { env } : {})
    });
    if (aiTitle) {
      return aiTitle;
    }
  }

  return deriveTitleFromInstructionText(normalized);
}

export type GenerateAndSetObjectiveTitleParams = {
  store: ObjectiveTitleStore;
  objectiveId: string;
  instructionText: string;
  aiTitleGenerationEnabled?: boolean;
  env?: NodeJS.ProcessEnv;
};

/**
 * Generates and persists a title for an executed objective.
 * Designed to be called fire-and-forget so it does not block callers.
 */
export async function generateAndSetObjectiveTitle(
  params: GenerateAndSetObjectiveTitleParams
): Promise<void> {
  const { store, objectiveId, instructionText, aiTitleGenerationEnabled, env } = params;
  const normalized = instructionText.trim();
  if (!normalized) {
    return;
  }

  const title = await generateObjectiveTitle({
    instructionText: normalized,
    ...(aiTitleGenerationEnabled === undefined ? {} : { aiTitleGenerationEnabled }),
    ...(env ? { env } : {})
  });

  if (!title) {
    return;
  }

  await store.updateObjectiveTitle({ objectiveId, title });
}
