/**
 * `@`-file mention semantics, shared by the interactive picker and any consumer
 * that needs to parse mentions back out. A mention is the literal token
 * `@<repo-relative-path>` embedded in plain text — the same convention the web
 * `MentionableTextarea` produces — so the two surfaces stay interchangeable.
 *
 * This module is intentionally dependency-free so its logic can be unit tested
 * against source. The git-backed file source lives in `repository-files.ts`.
 */

const MAX_MENTION_RESULTS = 20;

/** Matches an in-progress `@<query>` token immediately before the cursor. */
const ACTIVE_MENTION_PATTERN = /(?:^|[\s(\[])@([^\s@]*)$/;

export interface ActiveMention {
  /** Index of the `@` character in the buffer. */
  start: number;
  /** Text typed after the `@`, used to filter the file list. */
  query: string;
}

/**
 * Collapse a long path to a compact label, keeping the first and last segment:
 *   `cli/src/mentions.ts` → `cli/…/mentions.ts`
 */
export function getCollapsedFileMentionLabel(filePath: string): string {
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length <= 2) return segments.join('/');
  return `${segments[0]}/…/${segments[segments.length - 1]}`;
}

/** Locate an in-progress `@`-mention ending at `cursor`, or `null` if none. */
export function findActiveMention(text: string, cursor: number): ActiveMention | null {
  const before = text.slice(0, cursor);
  const match = ACTIVE_MENTION_PATTERN.exec(before);
  if (!match) return null;
  const query = match[1] ?? '';
  return { start: cursor - query.length - 1, query };
}

/** Files whose path contains `query` (case-insensitive), capped for display. */
export function fuzzyMatchFiles(files: string[], query: string, limit = MAX_MENTION_RESULTS): string[] {
  const needle = query.toLowerCase();
  const matches = needle ? files.filter(file => file.toLowerCase().includes(needle)) : files;
  return matches.slice(0, limit);
}

/**
 * Replace the active mention's `@<query>` with `@<filePath>`, adding a trailing
 * space when the following character is not already whitespace. Mirrors the web
 * component's `insertMentionAtCursor`.
 */
export function insertMention(
  text: string,
  mention: ActiveMention,
  filePath: string,
  cursor: number
): { text: string; cursor: number } {
  const suffix = text.slice(cursor);
  const needsSpace = suffix.length === 0 || (!suffix.startsWith(' ') && !suffix.startsWith('\n'));
  const mentionText = `@${filePath}${needsSpace ? ' ' : ''}`;
  return {
    text: `${text.slice(0, mention.start)}${mentionText}${suffix}`,
    cursor: mention.start + mentionText.length
  };
}
