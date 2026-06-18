import { ChevronDown, Tag } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { RepositoryMentionTextarea } from '@/components/RepositoryMentionTextarea.tsx';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu.tsx';
import { useProjects, useProjectTags } from '@/lib/queries.ts';
import type { TextareaHandle } from '@/lib/types/text-control';
import { cn } from '@/lib/utils.ts';

/** Options chosen in the card footer and forwarded to the create-ticket handler. */
export type BlankTicketCreateOptions = {
  /** Target project; defaults to the board's project when the picker is unused. */
  projectId?: string;
  /** `project_tags.id` values to assign to the new ticket. */
  tagIds?: string[];
};

type BlankTicketCardProps = {
  inputId: string;
  statusId: string;
  position: 'top' | 'bottom';
  projectId: string;
  expand?: boolean;
  closeOnSubmit?: boolean;
  onCreateTicket: (
    statusId: string,
    objective: string,
    position: 'top' | 'bottom',
    options?: BlankTicketCreateOptions
  ) => Promise<void> | void;
  onCreateAndOpenTicket?: (
    statusId: string,
    objective: string,
    position: 'top' | 'bottom',
    options?: BlankTicketCreateOptions
  ) => Promise<void> | void;
  onClose: () => void;
  onSubmitted?: () => void;
  focusTrigger?: number;
};

export function BlankTicketCard({
  inputId,
  statusId,
  position,
  projectId,
  expand = true,
  closeOnSubmit = false,
  onCreateTicket,
  onCreateAndOpenTicket,
  onClose,
  onSubmitted,
  focusTrigger = 0
}: BlankTicketCardProps) {
  const [value, setValue] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(projectId);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  const handleDismissRef = useRef<(currentValue: string) => Promise<void>>(async () => {});

  valueRef.current = value;

  const projectsQ = useProjects();
  const projects = useMemo(() => projectsQ.data ?? [], [projectsQ.data]);
  const tagsQ = useProjectTags(selectedProjectId);
  const activeTags = useMemo(() => (tagsQ.data ?? []).filter(tag => tag.active), [tagsQ.data]);

  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null;
  const showProjectPicker = projects.length > 1;
  const showTagPicker = Boolean(selectedProjectId) && activeTags.length > 0;

  // Keep the option refs current so the dismiss/submit callbacks below read the
  // latest selections without being torn down and rebuilt on every change.
  const optionsRef = useRef<BlankTicketCreateOptions>({ projectId, tagIds: [] });
  optionsRef.current = { projectId: selectedProjectId, tagIds: selectedTagIds };

  // A ticket created in another project can't keep this board column's status
  // (it belongs to the board's project), so only forward the status id when the
  // selection matches the board; otherwise the server falls back to the target
  // project's default status.
  const statusForSelection = selectedProjectId === projectId ? statusId : '';

  // Tags are project-scoped: clear the selection whenever the project changes.
  useEffect(() => {
    setSelectedTagIds([]);
  }, [selectedProjectId]);

  useEffect(() => {
    setSelectedProjectId(projectId);
  }, [projectId]);

  useEffect(() => {
    if (focusTrigger === 0) return;
    const textArea = document.getElementById(inputId) as TextareaHandle | null;
    if (!textArea) return;
    textArea.focus();
    const cursor = valueRef.current.length;
    textArea.setSelectionRange(cursor, cursor);
  }, [focusTrigger, inputId]);

  // When this card opens at the bottom of a column it can extend below the
  // window. autoFocus only scrolls the textarea into view, leaving the card's
  // footer controls below the fold, so scroll the whole card into view. A rAF
  // lets layout settle (including the textarea's measured height) before we
  // read the scroll geometry. `block: 'nearest'` scrolls the column just enough
  // to bring the card's bottom above the bottom of the window. Re-runs on
  // focusTrigger so the card stays visible after each successive submit.
  useEffect(() => {
    if (position !== 'bottom') return;
    const raf = requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [position, focusTrigger]);

  const toggleTag = useCallback((tagId: string) => {
    setSelectedTagIds(prev =>
      prev.includes(tagId) ? prev.filter(id => id !== tagId) : [...prev, tagId]
    );
  }, []);

  const handleBlur = useCallback(
    async (currentValue: string) => {
      if (isCreating) return;
      const trimmed = currentValue.trim();
      onClose();
      setValue('');
      if (trimmed) {
        setIsCreating(true);
        try {
          await onCreateTicket(statusForSelection, trimmed, position, optionsRef.current);
        } finally {
          setIsCreating(false);
        }
      }
    },
    [isCreating, onClose, onCreateTicket, position, statusForSelection]
  );

  handleDismissRef.current = handleBlur;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || cardRef.current?.contains(target)) return;

      const active = document.activeElement;
      const input = document.getElementById(inputId);
      const isThisCardFocused = active === input || Boolean(cardRef.current?.contains(active));
      if (!isThisCardFocused) return;

      void handleDismissRef.current(valueRef.current);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [inputId]);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        setValue('');
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (isCreating) return;
        const trimmed = e.currentTarget.value.trim();
        if (!trimmed) {
          onClose();
          setValue('');
          return;
        }
        setIsCreating(true);
        setValue('');
        try {
          if (e.metaKey && onCreateAndOpenTicket) {
            await onCreateAndOpenTicket(statusForSelection, trimmed, position, optionsRef.current);
          } else {
            await onCreateTicket(statusForSelection, trimmed, position, optionsRef.current);
          }
        } finally {
          setIsCreating(false);
        }
        if (closeOnSubmit) {
          onClose();
        }
        onSubmitted?.();
      }
    },
    [
      closeOnSubmit,
      isCreating,
      onClose,
      onCreateAndOpenTicket,
      onCreateTicket,
      onSubmitted,
      position,
      statusForSelection
    ]
  );

  return (
    <Card ref={cardRef} className="overflow-hidden rounded-md border-border/60 shadow-sm py-0">
      <CardContent className="p-2 ">
        <RepositoryMentionTextarea
          id={inputId}
          autoFocus
          projectId={selectedProjectId}
          value={value}
          onValueChange={setValue}
          placeholder="What needs to be done?"
          disabled={isCreating}
          onKeyDown={handleKeyDown}
          onBlur={e => {
            void handleBlur(e.currentTarget.value);
          }}
          className={
            expand
              ? 'min-h-[156px] resize-none border-0 p-1 text-sm shadow-none focus-visible:ring-0'
              : 'min-h-[78px] resize-none border-0 p-1 text-sm shadow-none focus-visible:ring-0'
          }
          rows={expand ? 7 : 4}
        />
        <div
          className="mt-1 flex items-center justify-between gap-2 px-1"
          onMouseDown={event => event.preventDefault()}
        >
          {onCreateAndOpenTicket ? (
            <p className="text-[11px] text-muted-foreground/50">⌘↵ to save &amp; open</p>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1">
            {showProjectPicker ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1.5 px-1.5 text-xs"
                      aria-label={
                        selectedProject
                          ? `Project: ${selectedProject.name}`
                          : 'Choose project for new ticket'
                      }
                      disabled={isCreating}
                    />
                  }
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[3px] border"
                    style={{
                      backgroundColor: selectedProject?.color ?? undefined,
                      borderColor: selectedProject?.color ?? undefined
                    }}
                  />
                  <span className="max-w-[8rem] truncate">
                    {selectedProject?.name ?? 'Project'}
                  </span>
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel>Project</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {projects.map(project => (
                    <DropdownMenuItem
                      key={project.id}
                      onClick={() => setSelectedProjectId(project.id)}
                      className="gap-2"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-[3px] border"
                        style={{
                          backgroundColor: project.color ?? undefined,
                          borderColor: project.color ?? undefined
                        }}
                      />
                      <span className="truncate">{project.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {showTagPicker ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(
                        'h-6 w-6 shrink-0',
                        selectedTagIds.length > 0 && 'text-foreground'
                      )}
                      aria-label="Add tags to new ticket"
                      disabled={isCreating}
                    />
                  }
                >
                  <Tag className="h-3.5 w-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {activeTags.map(tag => (
                    <DropdownMenuCheckboxItem
                      key={tag.id}
                      checked={selectedTagIds.includes(tag.id)}
                      onCheckedChange={() => toggleTag(tag.id)}
                      onSelect={event => event.preventDefault()}
                      className="gap-2"
                    >
                      {tag.color ? (
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full border"
                          style={{ backgroundColor: tag.color, borderColor: tag.color }}
                        />
                      ) : null}
                      <span className="truncate">{tag.label}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
