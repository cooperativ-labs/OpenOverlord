import * as React from 'react';

import {
  MentionableTextarea,
  type MissionMentionOption,
  type ProjectMentionOption
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
  /** Also save ~300ms after the user stops typing, instead of only on blur. Default `true`. */
  debounceSaveOnChange?: boolean;
};

/** Matches `leading-relaxed` (1.625) used on objective instruction surfaces. */
function minRowsMinHeightStyle(minRows: number): React.CSSProperties {
  return { minHeight: `${minRows * 1.625}em` };
}

const DEBOUNCE_SAVE_MS = 300;

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
  minRows,
  debounceSaveOnChange = true
}: InlineEditFieldProps) {
  const multilineMinRowsStyle = multiline && minRows ? minRowsMinHeightStyle(minRows) : undefined;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const draftRef = React.useRef(value);
  const saveTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Skip while editing so an autosave round-trip (debounced onChange below)
  // doesn't clobber keystrokes typed after the save fired but before the
  // updated `value` prop comes back from the server.
  React.useEffect(() => {
    if (editing) return;
    setDraft(value);
    draftRef.current = value;
  }, [value, editing]);

  const clearPendingSave = React.useCallback(() => {
    if (saveTimeoutRef.current === null) return;
    clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = null;
  }, []);

  React.useEffect(() => clearPendingSave, [clearPendingSave]);

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
    clearPendingSave();
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onSave(trimmed);
    else if (!trimmed && commitEmpty) onSave('');
    else setDraft(value);
  }, [clearPendingSave, commitEmpty, draft, value, onSave]);

  const cancel = React.useCallback(() => {
    clearPendingSave();
    setDraft(value);
    setEditing(false);
  }, [clearPendingSave, value]);

  // Mirrors `setDraft`, additionally (re)scheduling a debounced autosave so
  // edits persist ~300ms after the user pauses, on top of the on-blur commit.
  const updateDraft = React.useCallback(
    (next: string) => {
      draftRef.current = next;
      setDraft(next);
      if (!debounceSaveOnChange) return;
      clearPendingSave();
      saveTimeoutRef.current = setTimeout(() => {
        saveTimeoutRef.current = null;
        const trimmed = draftRef.current.trim();
        if (trimmed && trimmed !== value) onSave(trimmed);
        else if (!trimmed && commitEmpty) onSave('');
      }, DEBOUNCE_SAVE_MS);
    },
    [clearPendingSave, commitEmpty, debounceSaveOnChange, onSave, value]
  );

  if (disabled || !editing) {
    return (
      <span
        className={cn(
          'rounded  max-h-[360px]',
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
        onValueChange={updateDraft}
        mentionPaths={mentionPaths}
        projectMentionOptions={projectMentionOptions}
        missionMentionOptions={missionMentionOptions}
        autoListContinuation="enter"
        maxHeightPx={360}
        rows={minRows}
        aria-label={ariaLabel}
        style={multilineMinRowsStyle}
        className={cn('border-none bg-transparent', inputClassName)}
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
      className={cn(
        'h-full max-h-40 border-none bg-transparent hover:bg-transparent',
        inputClassName
      )}
      aria-label={ariaLabel}
      onChange={event => updateDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          cancel();
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
