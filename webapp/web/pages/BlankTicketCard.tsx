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

/**
 * Walk up from `node` to the nearest ancestor that actually scrolls vertically
 * (overflow-y of auto/scroll/overlay with real overflow). The board nests scroll
 * regions — the column's `overflow-y-auto` content area inside the page's
 * `overflow-auto` region — so we resolve the column's own scroller and move only
 * that, instead of letting `scrollIntoView` also shift the whole board.
 */
function findScrollableParent(node: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node.parentElement;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      el.scrollHeight > el.clientHeight
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * Bring the whole `card` (footer included) into view within its own scroll
 * container, and only when it overflows — a no-op when it already fits, so it
 * never yanks the view while the user types. Falls back to the browser's
 * `scrollIntoView` when no scrollable ancestor resolves.
 */
function revealCard(card: HTMLElement): void {
  const scroller = findScrollableParent(card);
  if (!scroller) {
    card.scrollIntoView({ block: 'nearest' });
    return;
  }
  const cardRect = card.getBoundingClientRect();
  const viewRect = scroller.getBoundingClientRect();
  const margin = 8;
  const overflowBottom = cardRect.bottom - (viewRect.bottom - margin);
  const overflowTop = viewRect.top + margin - cardRect.top;
  if (overflowBottom > 0) {
    scroller.scrollTop += overflowBottom;
  } else if (overflowTop > 0) {
    scroller.scrollTop -= overflowTop;
  }
}

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
  const overlayOwnerId = inputId;
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

  // When this card opens at the bottom of a column it is inserted below the
  // current scroll position and can sit beneath the fold — or, when the column
  // already fills the page, entirely below the bottom of the window. autoFocus
  // only scrolls the textarea into view (and races our own scroll), and the
  // card keeps growing *after* it mounts as its async project/tag pickers load
  // and the textarea autosizes, so a single post-mount scroll lands too early
  // and the card drifts back out of view. Reveal the whole card after layout
  // settles, then keep it visible across those later size changes with a
  // ResizeObserver. revealCard moves only the column's own scroller and only
  // when the card overflows it, so it never shifts the board or fights typing.
  // Re-runs on focusTrigger so the card stays visible after each submit.
  useEffect(() => {
    if (position !== 'bottom') return;
    const card = cardRef.current;
    if (!card) return;

    const reveal = () => revealCard(card);

    // Defer past autoFocus's scroll and the first paint so we read final
    // geometry instead of the card's initial (still-growing) height.
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(reveal);
    });

    // Keep the card in view as it grows once the pickers/textarea settle.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reveal) : null;
    observer?.observe(card);

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [position, focusTrigger]);

  const toggleTag = useCallback((tagId: string) => {
    setSelectedTagIds(prev =>
      prev.includes(tagId) ? prev.filter(id => id !== tagId) : [...prev, tagId]
    );
  }, []);

  const handleDismiss = useCallback(
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

  handleDismissRef.current = handleDismiss;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      const targetElement = target instanceof Element ? target : target.parentElement;
      const withinOwnedOverlay = targetElement?.closest(
        `[data-blank-ticket-card-owner="${overlayOwnerId}"]`
      );

      if (cardRef.current?.contains(target) || withinOwnedOverlay) return;

      const active = document.activeElement;
      const input = document.getElementById(inputId);
      const isThisCardFocused = active === input || Boolean(cardRef.current?.contains(active));
      if (!isThisCardFocused) return;

      void handleDismissRef.current(valueRef.current);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [inputId, overlayOwnerId]);

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
        onSubmitted?.();
      }
    },
    [
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
      <CardContent className="p-2 font-body">
        <RepositoryMentionTextarea
          id={inputId}
          autoFocus
          projectId={selectedProjectId}
          menuOwnerId={overlayOwnerId}
          value={value}
          onValueChange={setValue}
          placeholder="What needs to be done?"
          disabled={isCreating}
          onKeyDown={handleKeyDown}
          className="min-h-[156px] resize-none border-0 p-1 text-sm shadow-none focus-visible:ring-0"
          rows={7}
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
                <DropdownMenuContent
                  align="end"
                  className="w-48"
                  data-blank-ticket-card-owner={overlayOwnerId}
                >
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
                <DropdownMenuContent
                  align="end"
                  className="w-48"
                  data-blank-ticket-card-owner={overlayOwnerId}
                >
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
