import { generateGeminiText } from '../gemini-client.js';
import type { Automation } from '../../types.js';

export type SummarizeTextInput = {
  text: string;
  systemInstruction?: string;
  prompt?: string;
  maxLength?: number;
};

export async function summarizeTextWithGemini(
  params: SummarizeTextInput & { logPrefix?: string; env?: NodeJS.ProcessEnv }
): Promise<string | null> {
  const {
    text,
    systemInstruction = 'You write concise summaries. Return only the summary text, nothing else.',
    prompt,
    maxLength,
    logPrefix = '[automations/title-summarizer/summarize-text]',
    env
  } = params;

  const normalized = text.trim();
  if (!normalized) {
    return null;
  }

  const summaryPrompt =
    prompt ??
    `Summarize the following text. Return ONLY the summary, no quotes or punctuation wrapping.\n\nText:\n${normalized}`;

  const summary = await generateGeminiText({
    prompt: summaryPrompt,
    systemInstruction,
    temperature: 0.3,
    maxOutputTokens: 256,
    ...(env ? { env } : {}),
    logPrefix
  });

  if (!summary) {
    return null;
  }

  if (typeof maxLength === 'number' && summary.length > maxLength) {
    return `${summary.slice(0, maxLength)}…`;
  }

  return summary;
}

export const summarizeTextTool: Automation<SummarizeTextInput, string> = {
  id: 'summarize-text',
  label: 'Summarize text',
  description: 'Uses Gemini to summarize arbitrary text with an optional length cap.',
  run: async ({ input, context }) =>
    summarizeTextWithGemini({
      ...input,
      logPrefix: context?.logPrefix ?? '[automations/title-summarizer/summarize-text]'
    })
};
