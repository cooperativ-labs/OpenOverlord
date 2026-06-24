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
 * Walk up from `node` to the nearest ancestor styled as a vertical scroll
 * container (overflow-y of auto/scroll/overlay). The board nests scroll regions
 * — the column's `overflow-y-auto` content area inside the page's `overflow-auto`
 * region — so we resolve the column's own scroller and move only that, never the
 * whole board. This intentionally does *not* gate on current overflow: the bottom
 * card grows after mount (async pickers, field-sizing textarea), so a deferred
 * re-pin must still resolve the column even at the instant before it overflows.
 */
function findScrollContainer(node: HTMLElement): HTMLElement | null {
  let el: HTMLElement | null = node.parentElement;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * The bottom card is always the last child of the column's scroll area, so
 * pinning that scroller to its maximum offset flushes the card's footer to the
 * bottom of the column — which sits at the bottom of the window in the board
 * layout. This stays correct as the card grows (where a one-shot geometry delta
 * lands short) and is a natural no-op when the column doesn't overflow. Falls
 * back to the browser's `scrollIntoView` when no scroll container resolves.
 */
function pinCardToBottom(card: HTMLElement): void {
  const scroller = findScrollContainer(card);
  if (!scroller) {
    card.scrollIntoView({ block: 'nearest' });
    return;
  }
  scroller.scrollTop = scroller.scrollHeight;
}

/** Options chosen in the card footer and forwarded to the create-mission handler. */
export type BlankMissionCreateOptions = {
  /** Target project; defaults to the board's project when the picker is unused. */
  projectId?: string;
  /** `project_tags.id` values to assign to the new mission. */
  tagIds?: string[];
};

type BlankMissionCardProps = {
  inputId: string;
  statusId: string;
  position: 'top' | 'bottom';
  projectId: string;
  onCreateMission: (
    statusId: string,
    objective: string,
    position: 'top' | 'bottom',
    options?: BlankMissionCreateOptions
  ) => Promise<void> | void;
  onCreateAndOpenMission?: (
    statusId: string,
    objective: string,
    position: 'top' | 'bottom',
    options?: BlankMissionCreateOptions
  ) => Promise<void> | void;
  onClose: () => void;
  onSubmitted?: () => void;
  focusTrigger?: number;
};

export function BlankMissionCard({
  inputId,
  statusId,
  position,
  projectId,
  onCreateMission,
  onCreateAndOpenMission,
  onClose,
  onSubmitted,
  focusTrigger = 0
}: BlankMissionCardProps) {
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
  const optionsRef = useRef<BlankMissionCreateOptions>({ projectId, tagIds: [] });
  optionsRef.current = { projectId: selectedProjectId, tagIds: selectedTagIds };

  // A mission created in another project can't keep this board column's status
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
  // and the field-sizing textarea grows with input, so a single post-mount
  // scroll lands too early and the card drifts back out of view. Pin the column
  // to the bottom after layout settles, then keep it pinned across those later
  // size changes with a ResizeObserver. pinCardToBottom moves only the column's
  // own scroller, so it never shifts the board. Re-runs on focusTrigger so the
  // card stays in view after each submit.
  useEffect(() => {
    if (position !== 'bottom') return;
    const card = cardRef.current;
    if (!card) return;

    const pin = () => pinCardToBottom(card);

    // Defer past autoFocus's scroll and the first paint so the column has its
    // final scrollHeight (with the freshly mounted card) before we pin.
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(pin);
    });

    // Keep the card pinned as it grows once the pickers/textarea settle.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(pin) : null;
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
          await onCreateMission(statusForSelection, trimmed, position, optionsRef.current);
        } finally {
          setIsCreating(false);
        }
      }
    },
    [isCreating, onClose, onCreateMission, position, statusForSelection]
  );

  handleDismissRef.current = handleDismiss;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      const targetElement = target instanceof Element ? target : target.parentElement;
      const withinOwnedOverlay = targetElement?.closest(
        `[data-blank-mission-card-owner="${overlayOwnerId}"]`
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
          if (e.metaKey && onCreateAndOpenMission) {
            await onCreateAndOpenMission(statusForSelection, trimmed, position, optionsRef.current);
          } else {
            await onCreateMission(statusForSelection, trimmed, position, optionsRef.current);
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
      onCreateAndOpenMission,
      onCreateMission,
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
          {onCreateAndOpenMission ? (
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
                          : 'Choose project for new mission'
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
                  data-blank-mission-card-owner={overlayOwnerId}
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
                      aria-label="Add tags to new mission"
                      disabled={isCreating}
                    />
                  }
                >
                  <Tag className="h-3.5 w-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="w-48"
                  data-blank-mission-card-owner={overlayOwnerId}
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
