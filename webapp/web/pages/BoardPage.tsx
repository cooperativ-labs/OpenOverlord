import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
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
import { useEffect, useMemo, useState } from 'react';

import type { ProjectStatusDto, TicketDto, TicketPriority } from '../../shared/contract.ts';
import { ProjectSettingsSection } from '../components/projects/ProjectSettingsSection.tsx';
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
  statusClasses,
  TextArea
} from '../components/ui.tsx';
import {
  useCreateTicket,
  useProject,
  useProjectStatuses,
  useReorderBoardColumn,
  useTickets,
  useUpdateTicket
} from '../lib/queries.ts';

const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

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
          <TextArea
            autoFocus
            rows={3}
            value={instruction}
            placeholder="Describe the work to be executed…"
            onChange={e => setInstruction(e.target.value)}
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
  selectedTicketId
}: {
  status: ProjectStatusDto;
  tickets: TicketDto[];
  count: number;
  projectId: string;
  statuses: ProjectStatusDto[];
  selectedTicketId?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status.id });

  return (
    <div className="flex h-full min-h-0 w-72 shrink-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between px-1">
        <Badge className={statusClasses(status.type)}>
          {status.name}
          <span className="ml-1.5 opacity-60">{STATUS_LABEL[status.type]}</span>
        </Badge>
        <span className="text-xs text-[var(--color-ink-dim)]">{count}</span>
      </div>
      <SortableContext items={tickets.map(t => t.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1 transition-colors ${
            isOver
              ? 'bg-[var(--color-surface-2)]/40 ring-1 ring-inset ring-[var(--color-accent)]/30'
              : ''
          }`}
        >
          {tickets.map(t => (
            <SortableTicketCard
              key={t.id}
              ticket={t}
              projectId={projectId}
              statuses={statuses}
              selected={t.id === selectedTicketId}
            />
          ))}
        </div>
      </SortableContext>
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

  // The card currently being dragged, plus a local override of column membership
  // that is mutated live during the drag (and while the optimistic mutation lands)
  // so cross-column moves animate smoothly.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [override, setOverride] = useState<ColumnMap | null>(null);

  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);
  const tickets = useMemo(() => ticketsQ.data ?? [], [ticketsQ.data]);

  const ticketById = useMemo(() => {
    const map = new Map<string, TicketDto>();
    for (const t of tickets) map.set(t.id, t);
    return map;
  }, [tickets]);

  // Server-ordered column membership derived from the query cache. `tickets` is
  // already returned in board order, so a stable filter preserves it.
  const baseColumns = useMemo<ColumnMap>(() => {
    const map: ColumnMap = {};
    for (const s of statuses) map[s.id] = [];
    for (const t of tickets) (map[t.statusId] ??= []).push(t.id);
    return map;
  }, [statuses, tickets]);

  // Once the optimistic cache update has caught up to our local override, drop the
  // override so the cache is the single source of truth again (no visual flash).
  useEffect(() => {
    if (activeId === null && override !== null && columnMapsEqual(override, baseColumns)) {
      setOverride(null);
    }
  }, [activeId, override, baseColumns]);

  const sensors = useSensors(
    // A small activation distance lets plain clicks (navigate / open dropdown)
    // through while still capturing deliberate drags.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  if (project.isLoading || statusesQ.isLoading) {
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
        <div className="flex items-center justify-end gap-2 border-b border-[var(--color-border)] px-5 py-3">
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
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
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
                const ids = columns[status.id] ?? [];
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
