import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMatch, useNavigate, useParams } from '@tanstack/react-router';
import { LayoutGrid, List, Tag } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ProjectStatusDto, TicketDto, TicketPriority } from '../../shared/contract.ts';
import { ProjectSettingsSection } from '../components/projects/ProjectSettingsSection.tsx';
import { RepositoryMentionTextarea } from '../components/RepositoryMentionTextarea.tsx';
import { Button as ToolbarButton } from '../components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../components/ui/dropdown-menu.tsx';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  priorityClasses,
  Select,
  Spinner,
  STATUS_LABEL,
  statusClasses
} from '../components/ui.tsx';
import {
  useCreateTicket,
  useProject,
  useProjectStatuses,
  useReorderBoardColumn,
  useTickets,
  useUpdateTicket
} from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';

const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];
const BOARD_VIEW_STORAGE_PREFIX = 'overlord:project-board-view:';

type BoardView = 'board' | 'list';
type TicketTagFilterOption = { id: string; label: string; color: string | null };
type TicketTagValue = string | { id?: string; label?: string; name?: string; color?: string | null };
type TicketWithOptionalTags = TicketDto & {
  tags?: TicketTagValue[];
};

function getTicketTags(ticket: TicketDto): TicketTagFilterOption[] {
  const rawTags = (ticket as TicketWithOptionalTags).tags;
  if (!Array.isArray(rawTags)) return [];

  return rawTags
    .map(tag => {
      if (typeof tag === 'string') return { id: tag, label: tag, color: null };
      const id = tag.id?.trim();
      if (!id) return null;
      return {
        id,
        label: tag.label?.trim() || tag.name?.trim() || id,
        color: tag.color ?? null
      };
    })
    .filter((tag): tag is TicketTagFilterOption => tag !== null);
}

function getTagFilterLabel(selectedTagIds: string[], tagOptions: TicketTagFilterOption[]): string {
  if (selectedTagIds.length === 0) return 'All';
  if (selectedTagIds.length === 1) {
    return tagOptions.find(tag => tag.id === selectedTagIds[0])?.label ?? 'Tag';
  }
  return `${selectedTagIds.length} tags`;
}

function TicketTagFilterDropdown({
  tagOptions,
  selectedTagIds,
  onClear,
  onToggle
}: {
  tagOptions: TicketTagFilterOption[];
  selectedTagIds: string[];
  onClear: () => void;
  onToggle: (tagId: string) => void;
}) {
  if (tagOptions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            variant="outline"
            size="sm"
            className="gap-1.5"
            aria-label="Filter tickets by tag"
          />
        }
      >
        <Tag className="h-3.5 w-3.5" />
        {getTagFilterLabel(selectedTagIds, tagOptions)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuLabel>Filter by tag</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={selectedTagIds.length === 0}
          onCheckedChange={onClear}
          onSelect={event => event.preventDefault()}
        >
          All tags
        </DropdownMenuCheckboxItem>
        {tagOptions.map(tag => (
          <DropdownMenuCheckboxItem
            key={tag.id}
            checked={selectedTagIds.includes(tag.id)}
            onCheckedChange={() => onToggle(tag.id)}
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
  );
}

function NewTicketModal({
  open,
  onClose,
  projectId,
  statuses
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  statuses: ProjectStatusDto[];
}) {
  const create = useCreateTicket();
  const [instruction, setInstruction] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [statusId, setStatusId] = useState('');

  const submit = () => {
    const text = instruction.trim();
    if (!text) return;
    create.mutate(
      {
        projectId,
        firstObjective: text,
        priority,
        statusId: statusId || undefined
      },
      {
        onSuccess: () => {
          setInstruction('');
          setPriority('normal');
          setStatusId('');
          onClose();
        }
      }
    );
  };

  return (
    <Modal title="New ticket" open={open} onClose={onClose}>
      <div className="space-y-4">
        <Field label="What needs to be done?">
          <RepositoryMentionTextarea
            autoFocus
            rows={3}
            projectId={projectId}
            value={instruction}
            placeholder="Describe the work to be executed… (type @ to mention a file)"
            onValueChange={setInstruction}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select
              className="w-full"
              value={priority}
              onChange={e => setPriority(e.target.value as TicketPriority)}
            >
              {PRIORITIES.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select className="w-full" value={statusId} onChange={e => setStatusId(e.target.value)}>
              <option value="">Default ({statuses.find(s => s.isDefault)?.name ?? '—'})</option>
              {statuses.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {create.isError && (
          <p className="text-xs text-red-400">{(create.error as Error).message}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!instruction.trim() || create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create ticket'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function readStoredBoardView(projectId: string): BoardView {
  if (typeof window === 'undefined') return 'board';
  try {
    const value = window.localStorage.getItem(`${BOARD_VIEW_STORAGE_PREFIX}${projectId}`);
    return value === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function storeBoardView(projectId: string, view: BoardView) {
  try {
    window.localStorage.setItem(`${BOARD_VIEW_STORAGE_PREFIX}${projectId}`, view);
  } catch {
    // Ignore private browsing or quota failures; view switching still works in memory.
  }
}

function TicketsViewToggle({
  value,
  onChange
}: {
  value: BoardView;
  onChange: (value: BoardView) => void;
}) {
  const options: Array<{ value: BoardView; label: string; icon: typeof LayoutGrid }> = [
    { value: 'board', label: 'Board', icon: LayoutGrid },
    { value: 'list', label: 'List', icon: List }
  ];

  return (
    <div
      className="inline-flex h-9 items-center rounded-lg border border-border bg-muted/40 p-0.5"
      role="tablist"
      aria-label="Ticket view"
    >
      {options.map(option => {
        const Icon = option.icon;
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition',
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'hover:bg-background/60 hover:text-foreground'
            )}
            onClick={() => onChange(option.value)}
          >
            <Icon className="h-4 w-4" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The visual card body. Rendered both in-column (via {@link SortableTicketCard})
 * and inside the {@link DragOverlay} while a card is being dragged, so the markup
 * lives here once. A bare click navigates; the status dropdown stops propagation.
 */
function TicketCardBody({
  ticket,
  projectId,
  statuses,
  dragging,
  selected
}: {
  ticket: TicketDto;
  projectId: string;
  statuses: ProjectStatusDto[];
  dragging?: boolean;
  selected?: boolean;
}) {
  const navigate = useNavigate();
  const update = useUpdateTicket(ticket.id);

  return (
    <Card
      className={`space-y-2 p-3 ${
        dragging ? 'cursor-grabbing shadow-lg' : 'cursor-pointer'
      } ${selected ? 'ring-2 ring-[var(--color-accent)] ring-offset-1 ring-offset-[var(--color-surface-0)]' : ''}`}
      onClick={() =>
        navigate({
          to: '/projects/$projectId/tickets/$ticketId',
          params: { projectId, ticketId: ticket.id }
        })
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-[var(--color-ink-dim)]">{ticket.displayId}</span>
        {ticket.priority && (
          <Badge className={priorityClasses(ticket.priority)}>{ticket.priority}</Badge>
        )}
      </div>
      <p className="text-sm font-medium leading-snug">{ticket.title}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[var(--color-ink-dim)]">
          {ticket.objectiveCount} obj{ticket.objectiveCount === 1 ? '' : 's'}
        </span>
        <Select
          className="text-xs"
          value={ticket.statusId}
          // Keep dropdown interaction from starting a drag or navigating.
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          onChange={e => {
            e.stopPropagation();
            update.mutate({ statusId: e.target.value });
          }}
        >
          {statuses.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
    </Card>
  );
}

/** A draggable/sortable wrapper around {@link TicketCardBody}. */
function SortableTicketCard({
  ticket,
  projectId,
  statuses,
  selected
}: {
  ticket: TicketDto;
  projectId: string;
  statuses: ProjectStatusDto[];
  selected?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // While dragging, the real card rides in the DragOverlay; this slot becomes
      // a faint placeholder marking where it will land.
      className={`cursor-grab touch-none active:cursor-grabbing ${isDragging ? 'opacity-40' : ''}`}
      {...attributes}
      {...listeners}
    >
      <TicketCardBody
        ticket={ticket}
        projectId={projectId}
        statuses={statuses}
        selected={selected}
      />
    </div>
  );
}

/** A board column: a droppable surface wrapping the sortable list of its cards. */
function BoardColumn({
  status,
  tickets,
  count,
  projectId,
  statuses,
  selectedTicketId,
  draggable = true
}: {
  status: ProjectStatusDto;
  tickets: TicketDto[];
  count: number;
  projectId: string;
  statuses: ProjectStatusDto[];
  selectedTicketId?: string;
  draggable?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status.id });
  const content = (
    <div
      ref={setNodeRef}
      className={`flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1 transition-colors ${
        isOver
          ? 'bg-[var(--color-surface-2)]/40 ring-1 ring-inset ring-[var(--color-accent)]/30'
          : ''
      }`}
    >
      {tickets.map(t =>
        draggable ? (
          <SortableTicketCard
            key={t.id}
            ticket={t}
            projectId={projectId}
            statuses={statuses}
            selected={t.id === selectedTicketId}
          />
        ) : (
          <TicketCardBody
            key={t.id}
            ticket={t}
            projectId={projectId}
            statuses={statuses}
            selected={t.id === selectedTicketId}
          />
        )
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-72 shrink-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between px-1">
        <Badge className={statusClasses(status.type)}>
          {status.name}
          <span className="ml-1.5 opacity-60">{STATUS_LABEL[status.type]}</span>
        </Badge>
        <span className="text-xs text-[var(--color-ink-dim)]">{count}</span>
      </div>
      {draggable ? (
        <SortableContext items={tickets.map(t => t.id)} strategy={verticalListSortingStrategy}>
          {content}
        </SortableContext>
      ) : (
        content
      )}
    </div>
  );
}

function TicketListRow({
  ticket,
  projectId,
  statuses,
  selected
}: {
  ticket: TicketDto;
  projectId: string;
  statuses: ProjectStatusDto[];
  selected?: boolean;
}) {
  const navigate = useNavigate();
  const update = useUpdateTicket(ticket.id);

  const openTicket = () =>
    navigate({
      to: '/projects/$projectId/tickets/$ticketId',
      params: { projectId, ticketId: ticket.id }
    });

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${ticket.displayId}: ${ticket.title}`}
      className={cn(
        'grid w-full cursor-pointer grid-cols-[minmax(5rem,7rem)_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 text-left transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[minmax(5rem,7rem)_minmax(0,1fr)_8rem_9rem_auto]',
        selected && 'bg-primary/10 ring-1 ring-inset ring-primary/30'
      )}
      onClick={openTicket}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openTicket();
        }
      }}
    >
      <span className="font-mono text-xs text-muted-foreground">{ticket.displayId}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{ticket.title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">
          {ticket.objectiveCount} obj{ticket.objectiveCount === 1 ? '' : 's'}
        </span>
      </span>
      <span className="hidden text-xs text-muted-foreground md:block">
        {ticket.objectiveCount} obj{ticket.objectiveCount === 1 ? '' : 's'}
      </span>
      <span className="hidden md:block">
        {ticket.priority && (
          <Badge className={priorityClasses(ticket.priority)}>{ticket.priority}</Badge>
        )}
      </span>
      <Select
        className="max-w-32 text-xs"
        value={ticket.statusId}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
        onChange={e => {
          e.stopPropagation();
          update.mutate({ statusId: e.target.value });
        }}
      >
        {statuses.map(s => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function TicketListView({
  statuses,
  columns,
  ticketById,
  projectId,
  selectedTicketId
}: {
  statuses: ProjectStatusDto[];
  columns: ColumnMap;
  ticketById: Map<string, TicketDto>;
  projectId: string;
  selectedTicketId?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      {statuses.map(status => {
        const tickets = (columns[status.id] ?? [])
          .map(id => ticketById.get(id))
          .filter((ticket): ticket is TicketDto => ticket !== undefined);

        return (
          <section key={status.id} className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <Badge className={statusClasses(status.type)}>
                {status.name}
                <span className="ml-1.5 opacity-60">{STATUS_LABEL[status.type]}</span>
              </Badge>
              <span className="text-xs text-muted-foreground">{tickets.length}</span>
            </div>
            {tickets.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">No tickets in this status.</p>
            ) : (
              <div className="divide-y divide-border p-1">
                {tickets.map(ticket => (
                  <TicketListRow
                    key={ticket.id}
                    ticket={ticket}
                    projectId={projectId}
                    statuses={statuses}
                    selected={ticket.id === selectedTicketId}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

type ColumnMap = Record<string, string[]>;

function columnMapsEqual(a: ColumnMap, b: ColumnMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(k => {
    const av = a[k];
    const bv = b[k];
    return bv !== undefined && av.length === bv.length && av.every((id, i) => id === bv[i]);
  });
}

export function BoardPage() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const ticketMatch = useMatch({
    from: '/projects/$projectId/tickets/$ticketId',
    shouldThrow: false
  });
  const selectedTicketId = ticketMatch?.params.ticketId;
  const project = useProject(projectId);
  const statusesQ = useProjectStatuses(projectId);
  const ticketsQ = useTickets(projectId);
  const reorder = useReorderBoardColumn();
  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<BoardView>(() => readStoredBoardView(projectId));
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  // The card currently being dragged, plus a local override of column membership
  // that is mutated live during the drag (and while the optimistic mutation lands)
  // so cross-column moves animate smoothly.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [override, setOverride] = useState<ColumnMap | null>(null);

  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);
  const tickets = useMemo(() => ticketsQ.data ?? [], [ticketsQ.data]);

  useEffect(() => {
    setView(readStoredBoardView(projectId));
    setSelectedTagIds([]);
  }, [projectId]);

  const handleViewChange = (nextView: BoardView) => {
    setView(nextView);
    storeBoardView(projectId, nextView);
  };

  const ticketById = useMemo(() => {
    const map = new Map<string, TicketDto>();
    for (const t of tickets) map.set(t.id, t);
    return map;
  }, [tickets]);

  const tagOptions = useMemo(() => {
    const byId = new Map<string, TicketTagFilterOption>();
    for (const ticket of tickets) {
      for (const tag of getTicketTags(ticket)) {
        if (!byId.has(tag.id)) byId.set(tag.id, tag);
      }
    }
    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [tickets]);

  useEffect(() => {
    if (selectedTagIds.length === 0) return;
    const validIds = new Set(tagOptions.map(tag => tag.id));
    const next = selectedTagIds.filter(id => validIds.has(id));
    if (next.length !== selectedTagIds.length) setSelectedTagIds(next);
  }, [selectedTagIds, tagOptions]);

  const selectedTagIdSet = useMemo(() => new Set(selectedTagIds), [selectedTagIds]);
  const filteredTickets = useMemo(() => {
    if (selectedTagIds.length === 0) return tickets;
    return tickets.filter(ticket => getTicketTags(ticket).some(tag => selectedTagIdSet.has(tag.id)));
  }, [selectedTagIdSet, selectedTagIds.length, tickets]);

  // Server-ordered column membership derived from the query cache. `tickets` is
  // already returned in board order, so a stable filter preserves it.
  const baseColumns = useMemo<ColumnMap>(() => {
    const map: ColumnMap = {};
    for (const s of statuses) map[s.id] = [];
    for (const t of tickets) (map[t.statusId] ??= []).push(t.id);
    return map;
  }, [statuses, tickets]);

  const filteredColumns = useMemo<ColumnMap>(() => {
    const visibleTicketIds = new Set(filteredTickets.map(ticket => ticket.id));
    const map: ColumnMap = {};
    for (const s of statuses) {
      map[s.id] = (baseColumns[s.id] ?? []).filter(id => visibleTicketIds.has(id));
    }
    return map;
  }, [baseColumns, filteredTickets, statuses]);

  // Once the optimistic cache update has caught up to our local override, drop the
  // override so the cache is the single source of truth again (no visual flash).
  useEffect(() => {
    if (activeId === null && override !== null && columnMapsEqual(override, baseColumns)) {
      setOverride(null);
    }
  }, [activeId, override, baseColumns]);

  // pointerWithin switches columns the moment the pointer crosses a boundary,
  // avoiding the overshooting required by closestCorners. closestCenter is used
  // as a fallback for keyboard navigation where no pointer position is available.
  const collisionDetection = useCallback((...args: Parameters<typeof pointerWithin>) => {
    const hits = pointerWithin(...args);
    return hits.length > 0 ? hits : closestCenter(...args);
  }, []);

  const sensors = useSensors(
    // A small activation distance lets plain clicks (navigate / open dropdown)
    // through while still capturing deliberate drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (project.isLoading || statusesQ.isLoading || ticketsQ.isLoading) {
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  }
  if (project.isError) {
    return (
      <div className="p-8 text-sm text-red-400">
        Could not load project: {(project.error as Error).message}
      </div>
    );
  }

  const columns = override ?? baseColumns;
  const isTagFilterActive = selectedTagIds.length > 0;
  const visibleColumns = isTagFilterActive ? filteredColumns : columns;

  // Which column (status id) holds `id`, where `id` is either a card id or a
  // column id (dropping onto an empty column targets the column itself).
  const findColumn = (id: string): string | undefined => {
    if (id in columns) return id;
    return Object.keys(columns).find(statusId => columns[statusId].includes(id));
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setOverride(baseColumns);
  };

  // Live cross-column movement: while hovering a different column, move the active
  // card into it in the local override so the layout reflows under the cursor.
  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const fromCol = findColumn(activeId);
    const toCol = findColumn(overId);
    if (!fromCol || !toCol || fromCol === toCol) return;

    setOverride(prev => {
      const source = prev ?? baseColumns;
      const fromItems = source[fromCol];
      const toItems = source[toCol];
      const overIndex = toItems.indexOf(overId);
      // Dropping onto the column surface (not a card) appends to the end.
      const insertAt = overIndex >= 0 ? overIndex : toItems.length;
      return {
        ...source,
        [fromCol]: fromItems.filter(id => id !== activeId),
        [toCol]: [...toItems.slice(0, insertAt), activeId, ...toItems.slice(insertAt)]
      };
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const id = String(active.id);
    const dropColumn = over ? findColumn(String(over.id)) : undefined;

    setActiveId(null);

    if (!dropColumn) {
      setOverride(null);
      return;
    }

    const source = override ?? baseColumns;
    const items = source[dropColumn];
    const fromIndex = items.indexOf(id);
    const overIndex =
      over && String(over.id) !== dropColumn ? items.indexOf(String(over.id)) : items.length - 1;
    const finalItems =
      fromIndex !== -1 && overIndex !== -1 && fromIndex !== overIndex
        ? arrayMove(items, fromIndex, overIndex)
        : items;

    const finalColumns: ColumnMap = { ...source, [dropColumn]: finalItems };
    setOverride(finalColumns);

    // Nothing actually moved within this column and it didn't change membership.
    if (columnMapsEqual(finalColumns, baseColumns)) {
      setOverride(null);
      return;
    }

    const status = statuses.find(s => s.id === dropColumn);
    if (!status) {
      setOverride(null);
      return;
    }

    reorder.mutate({
      projectId,
      statusId: dropColumn,
      statusType: status.type,
      orderedTicketIds: finalItems
    });
  };

  const activeTicket = activeId ? ticketById.get(activeId) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 min-w-0">
        <ProjectSettingsSection
          projectId={projectId}
          initialName={project.data?.name ?? ''}
          initialColor={project.data?.color ?? null}
        />
        <div className="flex flex-wrap items-center justify-end gap-2 border-b border-[var(--color-border)] px-5 py-3">
          <TicketTagFilterDropdown
            tagOptions={tagOptions}
            selectedTagIds={selectedTagIds}
            onClear={() => setSelectedTagIds([])}
            onToggle={tagId =>
              setSelectedTagIds(current =>
                current.includes(tagId) ? current.filter(id => id !== tagId) : [...current, tagId]
              )
            }
          />
          <TicketsViewToggle value={view} onChange={handleViewChange} />
          <Button variant="primary" onClick={() => setModalOpen(true)}>
            + New ticket
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tickets.length === 0 ? (
          <EmptyState
            title="No tickets in this project"
            hint="Create a ticket to track a unit of work. Each ticket holds an ordered list of objectives."
            action={
              <Button variant="primary" onClick={() => setModalOpen(true)}>
                + New ticket
              </Button>
            }
          />
        ) : filteredTickets.length === 0 ? (
          <EmptyState
            title="No tickets match these filters"
            hint="Clear the active tag filter to show every ticket in this project."
            action={
              <Button variant="secondary" onClick={() => setSelectedTagIds([])}>
                Clear filters
              </Button>
            }
          />
        ) : view === 'board' && isTagFilterActive ? (
          <div className="flex h-full min-h-0 items-stretch gap-4">
            {statuses.map(status => {
              const ids = visibleColumns[status.id] ?? [];
              const colTickets = ids
                .map(id => ticketById.get(id))
                .filter((t): t is TicketDto => t !== undefined);
              return (
                <BoardColumn
                  key={status.id}
                  status={status}
                  tickets={colTickets}
                  count={colTickets.length}
                  projectId={projectId}
                  statuses={statuses}
                  selectedTicketId={selectedTicketId}
                  draggable={false}
                />
              );
            })}
          </div>
        ) : view === 'board' ? (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              setActiveId(null);
              setOverride(null);
            }}
          >
            <div className="flex h-full min-h-0 items-stretch gap-4">
              {statuses.map(status => {
                const ids = visibleColumns[status.id] ?? [];
                const colTickets = ids
                  .map(id => ticketById.get(id))
                  .filter((t): t is TicketDto => t !== undefined);
                return (
                  <BoardColumn
                    key={status.id}
                    status={status}
                    tickets={colTickets}
                    count={colTickets.length}
                    projectId={projectId}
                    statuses={statuses}
                    selectedTicketId={selectedTicketId}
                  />
                );
              })}
            </div>
            <DragOverlay>
              {activeTicket ? (
                <TicketCardBody
                  ticket={activeTicket}
                  projectId={projectId}
                  statuses={statuses}
                  dragging
                  selected={activeTicket.id === selectedTicketId}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <TicketListView
            statuses={statuses}
            columns={visibleColumns}
            ticketById={ticketById}
            projectId={projectId}
            selectedTicketId={selectedTicketId}
          />
        )}
      </div>

      <NewTicketModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        projectId={projectId}
        statuses={statuses}
      />
    </div>
  );
}
