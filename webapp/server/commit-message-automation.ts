import { generateGeminiText } from '@overlord/automations';

// Keep the prompt bounded so a large working tree doesn't blow past the model's
// context (and our token budget). The diff is the most useful signal; we trim it
// rather than the file list so the model always sees every changed path.
const MAX_DIFF_CHARS = 12000;

const SYSTEM_INSTRUCTION = [
  'You write concise, conventional git commit messages from a diff.',
  'Respond with ONLY the commit message — no markdown, code fences, or commentary.',
  'Format: a single imperative subject line of at most 72 characters, then,',
  'when the change is non-trivial, a blank line followed by 1–3 short bullet',
  'lines (each starting with "- ") summarizing what changed and why.',
  'Do not invent changes that are not in the diff.'
].join(' ');

/**
 * Drafts a commit message from a worktree diff via the Automations Layer (Gemini).
 * Returns the trimmed message, or `null` when the summarizer is unavailable
 * (e.g. no `GEMINI_API_KEY`) or returns nothing — the caller maps that to a
 * typed error so the UI can explain why no draft appeared.
 */
export async function generateCommitMessageFromDiff(params: {
  diff: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const trimmedDiff = params.diff.trim();
  if (!trimmedDiff) {
    return null;
  }

  const diff =
    trimmedDiff.length > MAX_DIFF_CHARS
      ? `${trimmedDiff.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated)…`
      : trimmedDiff;

  const message = await generateGeminiText({
    prompt: `Write a commit message for the following changes:\n\n${diff}`,
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0.3,
    maxOutputTokens: 320,
    env: params.env ?? process.env,
    logPrefix: '[webapp] commit-message automation'
  });

  return message?.trim() || null;
}
