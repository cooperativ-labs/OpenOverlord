import type { Automation } from '../../types.js';

import { summarizeTextWithGemini } from './summarize-text.js';

export const OBJECTIVE_TITLE_MAX_LENGTH = 60;
export const AI_TITLE_THRESHOLD = 100;

const OBJECTIVE_TITLE_SYSTEM_INSTRUCTION =
  'You write concise mission titles for a project management tool. Titles should be action-oriented (start with a verb), specific, capture the overall theme across all supplied objectives, and stay under 60 characters. Return only the title, nothing else.';

export type SummarizeObjectiveTitleInput = {
  instructionText: string;
};

/**
 * Uses Gemini to generate a concise objective title from long instruction context.
 * Returns null if Gemini is unavailable or the call fails.
 */
export async function summarizeObjectiveTitleWithGemini(
  params: SummarizeObjectiveTitleInput & { logPrefix?: string; env?: NodeJS.ProcessEnv }
): Promise<string | null> {
  const {
    instructionText,
    logPrefix = '[automations/title-summarizer/summarize-objective-title]',
    env
  } = params;

  const normalized = instructionText.trim();
  if (!normalized) {
    return null;
  }

  return summarizeTextWithGemini({
    text: normalized,
    systemInstruction: OBJECTIVE_TITLE_SYSTEM_INSTRUCTION,
    prompt: `Summarize the following mission objective context into a short, action-oriented title (max 60 characters). The context may include one objective or an ordered list of objectives across different states. Capture the overall theme of the mission, not just the latest item. Return ONLY the title text, no quotes or punctuation wrapping.\n\nObjective context:\n${normalized}`,
    maxLength: OBJECTIVE_TITLE_MAX_LENGTH,
    logPrefix,
    ...(env ? { env } : {})
  });
}

export const summarizeObjectiveTitleTool: Automation<SummarizeObjectiveTitleInput, string> = {
  id: 'summarize-objective-title',
  label: 'Summarize objective title',
  description:
    'Uses Gemini to turn long objective instruction text into a short action-oriented title.',
  run: async ({ input, context }) =>
    summarizeObjectiveTitleWithGemini({
      ...input,
      logPrefix: context?.logPrefix ?? '[automations/title-summarizer/summarize-objective-title]'
    })
};
