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
  useSensor,
  useSensors
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useMatch, useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';
import { ProjectSettingsSection } from '../components/projects/ProjectSettingsSection.tsx';
import { Button, EmptyState, Spinner } from '../components/ui.tsx';
import {
  useCreateTicket,
  useProject,
  useProjectStatuses,
  useReorderBoardColumn,
  useTickets,
  useWorkspaceMembers
} from '../lib/queries.ts';

import type { BlankTicketCreateOptions } from './BlankTicketCard.tsx';
import {
  type BoardView,
  type ColumnMap,
  columnMapsEqual,
  getTicketTags,
  readStoredBoardView,
  storeBoardView
} from './board-shared.ts';
import { BoardColumn } from './BoardColumn.tsx';
import { NewTicketModal } from './NewTicketModal.tsx';
import { SortableTicketCard } from './SortableTicketCard.tsx';
import { TicketListView } from './TicketListView.tsx';
import { TicketsViewToggle } from './TicketsViewToggle.tsx';
import { TicketTagFilterDropdown } from './TicketTagFilterDropdown.tsx';

export function BoardPage() {
  const navigate = useNavigate();
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const ticketMatch = useMatch({
    from: '/projects/$projectId/tickets/$ticketId',
    shouldThrow: false
  });
  const selectedTicketId = ticketMatch?.params.ticketId;
  const project = useProject(projectId);
  const statusesQ = useProjectStatuses(projectId);
  const ticketsQ = useTickets(projectId);
  const createTicket = useCreateTicket();
  const reorder = useReorderBoardColumn();
  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<BoardView>(() => readStoredBoardView(projectId));
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [override, setOverride] = useState<ColumnMap | null>(null);

  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);
  const tickets = useMemo(() => ticketsQ.data ?? [], [ticketsQ.data]);
  const workspaceId = project.data?.workspaceId ?? null;
  const membersQ = useWorkspaceMembers(workspaceId);

  const membersByWorkspaceUserId = useMemo(() => {
    const map = new Map<string, WorkspaceMemberDto>();
    for (const member of membersQ.data ?? []) {
      map.set(member.workspaceUserId, member);
    }
    return map;
  }, [membersQ.data]);

  const projectName = project.data?.name ?? '';
  const projectColor = project.data?.color ?? null;

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
    const byId = new Map<string, { id: string; label: string; color: string | null }>();
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
    return tickets.filter(ticket =>
      getTicketTags(ticket).some(tag => selectedTagIdSet.has(tag.id))
    );
  }, [selectedTagIdSet, selectedTagIds.length, tickets]);

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

  useEffect(() => {
    if (activeId === null && override !== null && columnMapsEqual(override, baseColumns)) {
      setOverride(null);
    }
  }, [activeId, override, baseColumns]);

  const collisionDetection = useCallback((...args: Parameters<typeof pointerWithin>) => {
    const hits = pointerWithin(...args);
    return hits.length > 0 ? hits : closestCenter(...args);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const placeCreatedTicket = useCallback(
    async ({
      statusId,
      position,
      ticketId
    }: {
      statusId: string;
      position: 'top' | 'bottom';
      ticketId: string;
    }) => {
      const status = statuses.find(s => s.id === statusId);
      if (!status) return;

      const existingIds = tickets
        .filter(ticket => ticket.statusId === statusId)
        .sort((a, b) => a.boardPosition - b.boardPosition)
        .map(ticket => ticket.id);

      const orderedTicketIds =
        position === 'top' ? [ticketId, ...existingIds] : [...existingIds, ticketId];

      await reorder.mutateAsync({
        projectId,
        statusId,
        statusType: status.type,
        orderedTicketIds
      });
    },
    [projectId, reorder, statuses, tickets]
  );

  const handleCreateTicketFromColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      position: 'top' | 'bottom',
      options?: BlankTicketCreateOptions
    ) => {
      const targetProjectId = options?.projectId ?? projectId;
      const tagIds = options?.tagIds ?? [];
      const detail = await createTicket.mutateAsync({
        projectId: targetProjectId,
        firstObjective: objective,
        ...(statusId ? { statusId } : {}),
        ...(tagIds.length > 0 ? { tagIds } : {})
      });
      // Reposition only when the ticket actually landed in this board column;
      // a different project/status means it lives on another board.
      if (statusId && targetProjectId === projectId) {
        await placeCreatedTicket({ statusId, position, ticketId: detail.id });
      }
    },
    [createTicket, placeCreatedTicket, projectId]
  );

  const handleCreateAndOpenTicketFromColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      position: 'top' | 'bottom',
      options?: BlankTicketCreateOptions
    ) => {
      const targetProjectId = options?.projectId ?? projectId;
      const tagIds = options?.tagIds ?? [];
      const detail = await createTicket.mutateAsync({
        projectId: targetProjectId,
        firstObjective: objective,
        ...(statusId ? { statusId } : {}),
        ...(tagIds.length > 0 ? { tagIds } : {})
      });
      if (statusId && targetProjectId === projectId) {
        await placeCreatedTicket({ statusId, position, ticketId: detail.id });
      }
      navigate({
        to: '/projects/$projectId/tickets/$ticketId',
        params: { projectId: targetProjectId, ticketId: detail.id }
      });
    },
    [createTicket, navigate, placeCreatedTicket, projectId]
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

  const findColumn = (id: string): string | undefined => {
    if (id in columns) return id;
    return Object.keys(columns).find(statusId => columns[statusId].includes(id));
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setOverride(baseColumns);
  };

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
  const activeAssignee = activeTicket?.assignedWorkspaceUserId
    ? membersByWorkspaceUserId.get(activeTicket.assignedWorkspaceUserId)
    : undefined;

  const columnProps = {
    projectId,
    projectName,
    projectColor,
    membersByWorkspaceUserId,
    selectedTicketId,
    onCreateTicket: handleCreateTicketFromColumn,
    onCreateAndOpenTicket: handleCreateAndOpenTicketFromColumn
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 min-w-0">
        <ProjectSettingsSection
          projectId={projectId}
          initialName={projectName}
          initialColor={projectColor}
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
                  draggable={false}
                  {...columnProps}
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
                    {...columnProps}
                  />
                );
              })}
            </div>
            <DragOverlay>
              {activeTicket ? (
                <SortableTicketCard
                  ticket={activeTicket}
                  projectId={projectId}
                  projectName={projectName}
                  projectColor={projectColor}
                  assignee={activeAssignee}
                  selected={activeTicket.id === selectedTicketId}
                  isDragOverlay
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
            projectName={projectName}
            projectColor={projectColor}
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedTicketId={selectedTicketId}
            draggable={!isTagFilterActive}
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
