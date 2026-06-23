import * as React from 'react';

import {
  MentionableTextarea,
  type ProjectMentionOption,
  type MissionMentionOption
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
  /** Missions offered for `$` mentions (multiline only). */
  missionMentionOptions?: MissionMentionOption[];
  /** Render the value as static, non-editable text. */
  disabled?: boolean;
  /** Commit an empty trimmed value instead of reverting to the previous value. */
  commitEmpty?: boolean;
  /** Accessible label for the editor. */
  ariaLabel?: string;
  /** Minimum visible line count when `multiline` (display + edit modes). */
  minRows?: number;
};

/** Matches `leading-relaxed` (1.625) used on objective instruction surfaces. */
function minRowsMinHeightStyle(minRows: number): React.CSSProperties {
  return { minHeight: `${minRows * 1.625}em` };
}

/**
 * Inline click-to-edit text. Displays a value that turns into an editor on
 * click: a single-line input, or — when `multiline` — a {@link MentionableTextarea}
 * with `@` file, `#` project, and `$` mission mentions, markdown list
 * continuation, and Save/Cancel affordances. Commits on blur or ⌘/Ctrl+Enter;
 * Escape cancels.
 *
 * Extracted from the former `EditableText` in `ui.tsx` and modelled on the
 * inline-edit pattern shared across the objective and mission surfaces.
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
  missionMentionOptions,
  disabled = false,
  commitEmpty = false,
  ariaLabel,
  minRows
}: InlineEditFieldProps) {
  const multilineMinRowsStyle = multiline && minRows ? minRowsMinHeightStyle(minRows) : undefined;
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
          multilineMinRowsStyle && 'block',
          !disabled && 'cursor-default',
          className,
          value ? '' : 'italic text-muted-foreground'
        )}
        style={multilineMinRowsStyle}
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
        missionMentionOptions={missionMentionOptions}
        autoListContinuation="enter"
        maxHeightPx={360}
        rows={minRows}
        aria-label={ariaLabel}
        style={multilineMinRowsStyle}
        className={cn('border-none bg-transparent ', inputClassName)}
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
      className={cn('h-full border-none bg-transparent hover:bg-transparent', inputClassName)}
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
