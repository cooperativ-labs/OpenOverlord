/**
 * Minimal surface of a text control that the mention machinery drives. A real
 * `HTMLTextAreaElement` satisfies this, but narrowing to the handle keeps the
 * cursor/focus logic testable and decoupled from the full DOM type.
 */
export interface TextareaHandle {
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
  selectionStart: number | null;
  selectionEnd: number | null;
}
