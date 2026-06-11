import * as React from 'react';
import { createPortal } from 'react-dom';

import { getCollapsedFileMentionLabel } from '@/lib/helpers/file-mentions';
import {
  applyMarkdownListContinuation,
  type AutoListContinuationMode,
  matchesListContinuationKey
} from '@/lib/helpers/list-continuation';
import type { TextareaHandle } from '@/lib/types/text-control';
import { cn } from '@/lib/utils';

const MAX_MENTION_RESULTS = 20;

export type ProjectMentionOption = {
  id: string;
  name: string;
};

type MentionableTextareaProps = Omit<
  React.ComponentProps<'textarea'>,
  'value' | 'onChange' | 'children'
> & {
  value: string;
  onValueChange: (nextValue: string) => void;
  mentionPaths?: string[];
  projectMentionOptions?: ProjectMentionOption[];
  containerClassName?: string;
  menuClassName?: string;
  mentionMenuMode?: 'portal' | 'inline';
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
  onMentionMenuOpenChange?: (open: boolean) => void;
  onMentionSelect?: (filePath: string) => void;
  onProjectMentionSelect?: (project: ProjectMentionOption) => void;
  /** Continue `1. ` / `- ` lists on newline; use `shift-enter` when plain Enter is reserved (e.g. submit). */
  autoListContinuation?: AutoListContinuationMode | false;
  /** When set, caps auto-grown height so the textarea scrolls internally instead of expanding past this pixel height. */
  maxHeightPx?: number;
};

export const MentionableTextarea = React.forwardRef<HTMLTextAreaElement, MentionableTextareaProps>(
  function MentionableTextarea(
    {
      value,
      onValueChange,
      mentionPaths = [],
      projectMentionOptions = [],
      className,
      containerClassName,
      menuClassName,
      mentionMenuMode = 'portal',
      onKeyDown,
      onBlur,
      onClick,
      onSelect,
      onChange,
      onMentionMenuOpenChange,
      onMentionSelect,
      onProjectMentionSelect,
      autoListContinuation = false,
      maxHeightPx,
      ...props
    },
    forwardedRef
  ) {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const mentionListRef = React.useRef<HTMLDivElement>(null);
    const projectMentionListRef = React.useRef<HTMLDivElement>(null);
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    // File (@) mention state
    const [mentionStart, setMentionStart] = React.useState<number | null>(null);
    const [mentionQuery, setMentionQuery] = React.useState('');
    const [mentionIndex, setMentionIndex] = React.useState(0);

    // Project (#) mention state
    const [projectMentionStart, setProjectMentionStart] = React.useState<number | null>(null);
    const [projectMentionQuery, setProjectMentionQuery] = React.useState('');
    const [projectMentionIndex, setProjectMentionIndex] = React.useState(0);

    const [mentionMenuPlacement, setMentionMenuPlacement] = React.useState<'top' | 'bottom'>(
      'bottom'
    );
    const [mentionMenuMaxHeight, setMentionMenuMaxHeight] = React.useState(224);
    const [menuPosition, setMenuPosition] = React.useState<{ top: number; left: number }>({
      top: 0,
      left: 0
    });

    const mentionResults = React.useMemo(
      () =>
        mentionPaths
          .filter(filePath => filePath.toLowerCase().includes(mentionQuery.toLowerCase()))
          .slice(0, MAX_MENTION_RESULTS),
      [mentionPaths, mentionQuery]
    );

    const mentionMenuOpen = mentionStart !== null && mentionResults.length > 0;

    const projectMentionResults = React.useMemo(
      () =>
        projectMentionOptions
          .filter(p => p.name.toLowerCase().includes(projectMentionQuery.toLowerCase()))
          .slice(0, MAX_MENTION_RESULTS),
      [projectMentionOptions, projectMentionQuery]
    );

    const projectMentionMenuOpen = projectMentionStart !== null && projectMentionResults.length > 0;

    const setRefs = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        textareaRef.current = node;
        if (!forwardedRef) return;
        if (typeof forwardedRef === 'function') {
          forwardedRef(node);
          return;
        }
        forwardedRef.current = node;
      },
      [forwardedRef]
    );

    const clearMentionState = React.useCallback(() => {
      setMentionStart(null);
      setMentionQuery('');
      setMentionIndex(0);
    }, []);

    const clearProjectMentionState = React.useCallback(() => {
      setProjectMentionStart(null);
      setProjectMentionQuery('');
      setProjectMentionIndex(0);
    }, []);

    const updateMentionState = React.useCallback(
      (nextValue: string, cursorPosition: number) => {
        if (mentionPaths.length === 0) {
          clearMentionState();
        } else {
          const beforeCursor = nextValue.slice(0, cursorPosition);
          const tokenMatch = beforeCursor.match(/(^|[\s(\[])@([^\s@]*)$/);
          if (!tokenMatch) {
            clearMentionState();
          } else {
            const query = tokenMatch[2] ?? '';
            const atSymbolPosition = cursorPosition - query.length - 1;
            setMentionStart(atSymbolPosition);
            setMentionQuery(query);
            setMentionIndex(0);
          }
        }

        if (projectMentionOptions.length === 0) {
          clearProjectMentionState();
        } else {
          const beforeCursor = nextValue.slice(0, cursorPosition);
          const tokenMatch = beforeCursor.match(/(^|[\s(\[])#([^\s#[]*)$/);
          if (!tokenMatch) {
            clearProjectMentionState();
          } else {
            const query = tokenMatch[2] ?? '';
            const hashPosition = cursorPosition - query.length - 1;
            setProjectMentionStart(hashPosition);
            setProjectMentionQuery(query);
            setProjectMentionIndex(0);
          }
        }
      },
      [
        mentionPaths.length,
        clearMentionState,
        projectMentionOptions.length,
        clearProjectMentionState
      ]
    );

    const updateMentionMenuPosition = React.useCallback(() => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const viewportPadding = 8;
      const gap = 4;
      const preferredMaxHeight = 320;
      const minMenuHeight = 96;

      const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const spaceAbove = rect.top - gap - viewportPadding;

      const shouldOpenAbove = spaceBelow < minMenuHeight && spaceAbove > spaceBelow;
      const availableSpace = shouldOpenAbove ? spaceAbove : spaceBelow;

      setMentionMenuPlacement(shouldOpenAbove ? 'top' : 'bottom');
      setMentionMenuMaxHeight(
        Math.max(minMenuHeight, Math.min(preferredMaxHeight, Math.floor(availableSpace)))
      );

      setMenuPosition({
        top: shouldOpenAbove ? rect.top - gap : rect.bottom + gap,
        left: rect.left
      });
    }, []);

    const insertMentionAtCursor = React.useCallback(
      (filePath: string) => {
        const textArea = textareaRef.current as
          | (TextareaHandle & {
              selectionStart: number | null;
            })
          | null;

        if (!textArea || mentionStart === null || !filePath) return;

        const cursor = textArea.selectionStart ?? value.length;
        let mentionText = `@${filePath}`;
        const suffix = value.slice(cursor);

        if (suffix.length === 0 || (!suffix.startsWith(' ') && !suffix.startsWith('\n'))) {
          mentionText += ' ';
        }

        const nextValue = `${value.slice(0, mentionStart)}${mentionText}${suffix}`;
        const nextCursor = mentionStart + mentionText.length;

        onValueChange(nextValue);
        onMentionSelect?.(filePath);
        clearMentionState();

        requestAnimationFrame(() => {
          textArea.focus();
          textArea.setSelectionRange(nextCursor, nextCursor);
        });
      },
      [mentionStart, value, onValueChange, onMentionSelect, clearMentionState]
    );

    const insertProjectMentionAtCursor = React.useCallback(
      (project: ProjectMentionOption) => {
        const textArea = textareaRef.current as
          | (TextareaHandle & {
              selectionStart: number | null;
            })
          | null;

        if (!textArea || projectMentionStart === null || !project.name) return;

        const cursor = textArea.selectionStart ?? value.length;
        let mentionText = `#[${project.name}]`;
        const suffix = value.slice(cursor);

        if (suffix.length === 0 || (!suffix.startsWith(' ') && !suffix.startsWith('\n'))) {
          mentionText += ' ';
        }

        const nextValue = `${value.slice(0, projectMentionStart)}${mentionText}${suffix}`;
        const nextCursor = projectMentionStart + mentionText.length;

        onValueChange(nextValue);
        onProjectMentionSelect?.(project);
        clearProjectMentionState();

        requestAnimationFrame(() => {
          textArea.focus();
          textArea.setSelectionRange(nextCursor, nextCursor);
        });
      },
      [projectMentionStart, value, onValueChange, onProjectMentionSelect, clearProjectMentionState]
    );

    React.useEffect(() => {
      const anyMenuOpen = mentionMenuOpen || projectMentionMenuOpen;
      if (!anyMenuOpen || mentionMenuMode !== 'portal') return;

      updateMentionMenuPosition();
      window.addEventListener('resize', updateMentionMenuPosition);
      window.addEventListener('scroll', updateMentionMenuPosition, true);

      return () => {
        window.removeEventListener('resize', updateMentionMenuPosition);
        window.removeEventListener('scroll', updateMentionMenuPosition, true);
      };
    }, [mentionMenuOpen, projectMentionMenuOpen, mentionMenuMode, updateMentionMenuPosition]);

    React.useEffect(() => {
      onMentionMenuOpenChange?.(mentionMenuOpen || projectMentionMenuOpen);
    }, [mentionMenuOpen, projectMentionMenuOpen, onMentionMenuOpenChange]);

    React.useEffect(() => {
      if (!mentionMenuOpen) return;

      const listEl = mentionListRef.current;
      if (!listEl) return;

      const active = listEl.querySelector<HTMLElement>(`[data-mention-index="${mentionIndex}"]`);
      active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [mentionMenuOpen, mentionIndex]);

    React.useEffect(() => {
      if (!projectMentionMenuOpen) return;

      const listEl = projectMentionListRef.current;
      if (!listEl) return;

      const active = listEl.querySelector<HTMLElement>(
        `[data-project-mention-index="${projectMentionIndex}"]`
      );
      active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [projectMentionMenuOpen, projectMentionIndex]);

    React.useEffect(() => {
      if (mentionPaths.length > 0) return;
      clearMentionState();
    }, [mentionPaths.length, clearMentionState]);

    React.useEffect(() => {
      if (projectMentionOptions.length > 0) return;
      clearProjectMentionState();
    }, [projectMentionOptions.length, clearProjectMentionState]);

    React.useEffect(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const prevWindowScrollY = window.scrollY;
      const prevTextareaScrollTop = textarea.scrollTop;

      textarea.style.height = 'auto';
      const cap = maxHeightPx ?? Number.POSITIVE_INFINITY;
      const nextHeight = Math.min(textarea.scrollHeight, cap);
      textarea.style.height = `${nextHeight}px`;

      window.scrollTo(0, prevWindowScrollY);
      const maxScrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
      textarea.scrollTop = Math.min(prevTextareaScrollTop, maxScrollTop);
    }, [value, maxHeightPx]);

    const menuStyle =
      mentionMenuMode === 'portal'
        ? {
            top: mentionMenuPlacement === 'top' ? undefined : menuPosition.top,
            bottom:
              mentionMenuPlacement === 'top' ? window.innerHeight - menuPosition.top : undefined,
            left: menuPosition.left,
            maxHeight: mentionMenuMaxHeight
          }
        : undefined;

    const mentionMenu = mentionMenuOpen ? (
      <div
        ref={mentionListRef}
        className={cn(
          mentionMenuMode === 'portal'
            ? 'fixed z-50 w-max max-w-[min(64rem,calc(100vw-1rem))] overflow-x-auto overflow-y-auto rounded-md border bg-popover p-1 shadow-md'
            : 'mt-2 max-h-56 overflow-x-auto overflow-y-auto rounded-xl border bg-background/95 p-1 shadow-sm backdrop-blur-md',
          menuClassName
        )}
        style={menuStyle}
      >
        {mentionResults.map((filePath, index) => (
          <button
            key={filePath}
            data-mention-index={index}
            className={cn(
              'block w-full whitespace-nowrap rounded px-2 py-1.5 text-left text-sm transition-colors',
              index === mentionIndex
                ? 'bg-muted-foreground/30 text-foreground shadow-sm'
                : 'text-foreground hover:bg-muted-foreground/30'
            )}
            type="button"
            onMouseDown={event => {
              event.preventDefault();
              insertMentionAtCursor(filePath);
            }}
          >
            <span className="font-medium">@{getCollapsedFileMentionLabel(filePath)}</span>
            <span
              className={cn(
                'ml-2 text-xs',
                index === mentionIndex ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {filePath}
            </span>
          </button>
        ))}
      </div>
    ) : null;

    const projectMentionMenu = projectMentionMenuOpen ? (
      <div
        ref={projectMentionListRef}
        className={cn(
          mentionMenuMode === 'portal'
            ? 'fixed z-50 w-max max-w-[min(48rem,calc(100vw-1rem))] overflow-x-auto overflow-y-auto rounded-md border bg-popover p-1 shadow-md'
            : 'mt-2 max-h-56 overflow-x-auto overflow-y-auto rounded-xl border bg-background/95 p-1 shadow-sm backdrop-blur-md',
          menuClassName
        )}
        style={menuStyle}
      >
        {projectMentionResults.map((project, index) => (
          <button
            key={project.id}
            data-project-mention-index={index}
            className={cn(
              'block w-full whitespace-nowrap rounded px-2 py-1.5 text-left text-sm transition-colors',
              index === projectMentionIndex
                ? 'bg-muted-foreground/30 text-foreground shadow-sm'
                : 'text-foreground hover:bg-muted-foreground/30'
            )}
            type="button"
            onMouseDown={event => {
              event.preventDefault();
              insertProjectMentionAtCursor(project);
            }}
          >
            <span className="font-medium">#{project.name}</span>
          </button>
        ))}
      </div>
    ) : null;

    return (
      <div ref={containerRef} className={cn('relative w-full', containerClassName)}>
        <textarea
          ref={setRefs}
          className={cn(
            'relative z-10 w-full resize-none overflow-y-auto focus:outline-none focus-visible:ring-0',
            className
          )}
          value={value}
          onChange={event => {
            const nextValue = event.target.value;
            onValueChange(nextValue);
            updateMentionState(nextValue, event.target.selectionStart ?? nextValue.length);
            onChange?.(event);
          }}
          onClick={event => {
            updateMentionState(value, event.currentTarget.selectionStart ?? value.length);
            onClick?.(event);
          }}
          onSelect={event => {
            updateMentionState(value, event.currentTarget.selectionStart ?? value.length);
            onSelect?.(event);
          }}
          onBlur={event => {
            clearMentionState();
            clearProjectMentionState();
            onBlur?.(event);
          }}
          onKeyDown={event => {
            if (mentionMenuOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setMentionIndex(current => (current + 1) % mentionResults.length);
                return;
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setMentionIndex(
                  current => (current - 1 + mentionResults.length) % mentionResults.length
                );
                return;
              }

              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                insertMentionAtCursor(mentionResults[mentionIndex] ?? mentionResults[0] ?? '');
                return;
              }

              if (event.key === 'Escape') {
                event.preventDefault();
                clearMentionState();
                return;
              }
            }

            if (projectMentionMenuOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setProjectMentionIndex(current => (current + 1) % projectMentionResults.length);
                return;
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setProjectMentionIndex(
                  current =>
                    (current - 1 + projectMentionResults.length) % projectMentionResults.length
                );
                return;
              }

              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                const selected =
                  projectMentionResults[projectMentionIndex] ?? projectMentionResults[0];
                if (selected) insertProjectMentionAtCursor(selected);
                return;
              }

              if (event.key === 'Escape') {
                event.preventDefault();
                clearProjectMentionState();
                return;
              }
            }

            if (
              autoListContinuation &&
              !event.nativeEvent.isComposing &&
              matchesListContinuationKey({
                mode: autoListContinuation,
                key: event.key,
                shiftKey: event.shiftKey
              })
            ) {
              const start = event.currentTarget.selectionStart ?? value.length;
              const end = event.currentTarget.selectionEnd ?? value.length;

              const result = applyMarkdownListContinuation({
                value,
                selectionStart: start,
                selectionEnd: end
              });

              if (result.applied) {
                event.preventDefault();
                onValueChange(result.nextValue);
                updateMentionState(result.nextValue, result.nextSelection);

                requestAnimationFrame(() => {
                  const textArea = textareaRef.current as TextareaHandle | null;
                  if (!textArea) return;
                  textArea.focus();
                  textArea.setSelectionRange(result.nextSelection, result.nextSelection);
                });

                return;
              }
            }

            onKeyDown?.(event);
          }}
          {...props}
        />

        {mentionMenuMode === 'portal' && mentionMenu
          ? createPortal(mentionMenu, document.body)
          : mentionMenu}

        {mentionMenuMode === 'portal' && projectMentionMenu
          ? createPortal(projectMentionMenu, document.body)
          : projectMentionMenu}
      </div>
    );
  }
);

MentionableTextarea.displayName = 'MentionableTextarea';
