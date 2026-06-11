/**
 * Markdown list continuation: when the caret sits at the end of a `- `, `* ` or
 * `1. ` list item and the user presses the continuation key, start the next item
 * automatically. Pressing it again on an empty item ends the list.
 *
 * `enter` is the default; use `shift-enter` when plain Enter is reserved for
 * submitting the surrounding form.
 */
export type AutoListContinuationMode = 'enter' | 'shift-enter';

interface ListContinuationKeyEvent {
  mode: AutoListContinuationMode;
  key: string;
  shiftKey: boolean;
}

export function matchesListContinuationKey({
  mode,
  key,
  shiftKey
}: ListContinuationKeyEvent): boolean {
  if (key !== 'Enter') return false;
  return mode === 'shift-enter' ? shiftKey : !shiftKey;
}

interface ListContinuationInput {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

interface ListContinuationResult {
  applied: boolean;
  nextValue: string;
  nextSelection: number;
}

// Captures leading indentation, the marker (`-`, `*`, `+`, or `N.`/`N)`), the
// gap after it, and whatever content follows on the line.
const LIST_ITEM_PATTERN = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(.*)$/;

export function applyMarkdownListContinuation({
  value,
  selectionStart,
  selectionEnd
}: ListContinuationInput): ListContinuationResult {
  const noChange: ListContinuationResult = {
    applied: false,
    nextValue: value,
    nextSelection: selectionStart
  };

  // Only continue a list for a collapsed caret, not an active selection.
  if (selectionStart !== selectionEnd) return noChange;

  const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
  const lineEnd = value.indexOf('\n', selectionStart);
  const line = value.slice(lineStart, lineEnd === -1 ? value.length : lineEnd);

  const match = LIST_ITEM_PATTERN.exec(line);
  if (!match) return noChange;

  const [, indent, bullet, numberText, numberDelimiter, gap, content] = match;

  // Empty item → user wants out of the list: clear the marker on this line.
  if (content.length === 0) {
    const nextValue =
      value.slice(0, lineStart) + value.slice(lineEnd === -1 ? value.length : lineEnd);
    return { applied: true, nextValue, nextSelection: lineStart };
  }

  const marker = bullet ?? `${Number.parseInt(numberText ?? '0', 10) + 1}${numberDelimiter ?? '.'}`;
  const insertion = `\n${indent}${marker}${gap}`;
  const nextValue = value.slice(0, selectionStart) + insertion + value.slice(selectionStart);

  return {
    applied: true,
    nextValue,
    nextSelection: selectionStart + insertion.length
  };
}
