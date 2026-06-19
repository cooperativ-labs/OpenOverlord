import * as React from 'react';

import {
  MentionableTextarea,
  type ProjectMentionOption,
  type TicketMentionOption
} from '@/components/MentionableTextarea';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type InlineEditFieldProps = {
  value: string;
  onSave: (next: string) => void;
  /** Edit in a multiline, mention-aware textarea instead of a single-line input. */
  multiline?: boolean;
  /** Classes applied to the static display element. */
  className?: string;
  /** Shown (italic, muted) when the value is empty. */
  placeholder?: string;
  /** Classes applied to the input/textarea while editing. */
  inputClassName?: string;
  /** File paths offered for `@` mentions (multiline only). */
  mentionPaths?: string[];
  /** Projects offered for `#` mentions (multiline only). */
  projectMentionOptions?: ProjectMentionOption[];
  /** Tickets offered for `$` mentions (multiline only). */
  ticketMentionOptions?: TicketMentionOption[];
  /** Render the value as static, non-editable text. */
  disabled?: boolean;
  /** Commit an empty trimmed value instead of reverting to the previous value. */
  commitEmpty?: boolean;
  /** Accessible label for the editor. */
  ariaLabel?: string;
};

/**
 * Inline click-to-edit text. Displays a value that turns into an editor on
 * click: a single-line input, or — when `multiline` — a {@link MentionableTextarea}
 * with `@` file, `#` project, and `$` ticket mentions, markdown list
 * continuation, and Save/Cancel affordances. Commits on blur or ⌘/Ctrl+Enter;
 * Escape cancels.
 *
 * Extracted from the former `EditableText` in `ui.tsx` and modelled on the
 * inline-edit pattern shared across the objective and ticket surfaces.
 */
export function InlineEditField({
  value,
  onSave,
  multiline = false,
  className,
  placeholder = 'Click to edit',
  inputClassName,
  mentionPaths,
  projectMentionOptions,
  ticketMentionOptions,
  disabled = false,
  commitEmpty = false,
  ariaLabel
}: InlineEditFieldProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => setDraft(value), [value]);

  // Focus and place the caret at the end when entering multiline edit mode.
  React.useEffect(() => {
    if (!editing || !multiline) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [editing, multiline]);

  const commit = React.useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    else if (!trimmed && commitEmpty) onSave('');
    else setDraft(value);
  }, [commitEmpty, draft, value, onSave]);

  const cancel = React.useCallback(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  if (disabled || !editing) {
    return (
      <span
        className={cn(
          'rounded',
          !disabled && 'cursor-text hover:bg-muted',
          className,
          value ? '' : 'italic text-muted-foreground'
        )}
        onClick={disabled ? undefined : () => setEditing(true)}
        title={disabled ? undefined : 'Click to edit'}
      >
        {value || placeholder}
      </span>
    );
  }

  if (multiline) {
    return (
      <MentionableTextarea
        ref={textareaRef}
        value={draft}
        onValueChange={setDraft}
        mentionPaths={mentionPaths}
        projectMentionOptions={projectMentionOptions}
        ticketMentionOptions={ticketMentionOptions}
        autoListContinuation="enter"
        maxHeightPx={360}
        aria-label={ariaLabel}
        className={cn(
          'min-h-20 rounded-lg bg-transparent text-sm leading-relaxed shadow-xs transition-colors dark:bg-input/30',
          inputClassName
        )}
        // Clicking outside (anywhere but the mention menu, whose buttons
        // preventDefault on mousedown to keep focus) commits the edit.
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
            return;
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            commit();
          }
        }}
      />
    );
  }

  return (
    <Input
      autoFocus
      value={draft}
      className={cn('h-8', inputClassName)}
      aria-label={ariaLabel}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          setDraft(value);
          setEditing(false);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

/**
 * Backwards-compatible alias for {@link InlineEditField}. Prefer
 * `InlineEditField` in new code.
 */
export const EditableText = InlineEditField;
