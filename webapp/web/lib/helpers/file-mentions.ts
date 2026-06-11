/**
 * Shared semantics for `@`-file mentions. A mention is the literal token
 * `@<repo-relative-path>` embedded in plain text — the same convention the CLI
 * picker produces — so the two surfaces stay interchangeable.
 */

/**
 * Collapse a long path to a compact menu label, keeping the first and last
 * segment so both the area of the tree and the file name stay legible:
 *   `web/components/features/MentionableTextarea.tsx` → `web/…/MentionableTextarea.tsx`
 */
export function getCollapsedFileMentionLabel(filePath: string): string {
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length <= 2) return segments.join('/');
  return `${segments[0]}/…/${segments[segments.length - 1]}`;
}
