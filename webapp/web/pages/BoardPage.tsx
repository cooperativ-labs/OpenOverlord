import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useMatch, useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { NewTicketModal } from '@/components/NewTicketModal.tsx';

import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';
import { ProjectSettingsSection } from '../components/projects/ProjectSettingsSection.tsx';
import { Button, EmptyState, Spinner } from '../components/ui.tsx';
import {
  useCreateTicket,
  useProject,
  useProjectTags,
  useReorderBoardColumn,
  useTickets,
  useWorkspaceMembers,
  useWorkspaceStatuses
} from '../lib/queries.ts';

import type { BlankTicketCreateOptions } from './BlankTicketCard.tsx';
import {
  type BoardView,
  type ColumnMap,
  getTicketTags,
  readStoredBoardView,
  resolveAssignee,
  resolveColumnTickets,
  storeBoardView
} from './board-shared.ts';
import { BoardColumn } from './BoardColumn.tsx';
import { SortableTicketCard } from './SortableTicketCard.tsx';
import { TicketListView } from './TicketListView.tsx';
import { TicketsViewToggle } from './TicketsViewToggle.tsx';
import { TicketTagFilterDropdown } from './TicketTagFilterDropdown.tsx';
import { useBoardColumnDnd } from './useBoardColumnDnd.ts';

export function BoardPage() {
  const navigate = useNavigate();
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const ticketMatch = useMatch({
    from: '/projects/$projectId/tickets/$ticketId',
    shouldThrow: false
  });
  const selectedTicketId = ticketMatch?.params.ticketId;
  const project = useProject(projectId);
  const statusesQ = useWorkspaceStatuses();
  const ticketsQ = useTickets(projectId);
  const projectTagsQ = useProjectTags(projectId);
  const createTicket = useCreateTicket();
  const reorder = useReorderBoardColumn();
  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<BoardView>(() => readStoredBoardView(projectId));
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

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

  const tagOptions = useMemo(
    () =>
      (projectTagsQ.data ?? [])
        .filter(tag => tag.active)
        .map(tag => ({
          id: tag.id,
          label: tag.label,
          color: tag.color
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [projectTagsQ.data]
  );

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

  const { activeId, displayColumns, dndContextProps } = useBoardColumnDnd({
    columns: baseColumns,
    statuses,
    projectId
  });

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

  // Shared creation path for the two column callbacks below: create the ticket,
  // then reposition it within this board column when it actually landed here
  // (a different project/status means it lives on another board).
  const createTicketInColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      position: 'top' | 'bottom',
      options?: BlankTicketCreateOptions
    ): Promise<{ ticketId: string; targetProjectId: string }> => {
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
      return { ticketId: detail.id, targetProjectId };
    },
    [createTicket, placeCreatedTicket, projectId]
  );

  const handleCreateTicketFromColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      position: 'top' | 'bottom',
      options?: BlankTicketCreateOptions
    ) => {
      await createTicketInColumn(statusId, objective, position, options);
    },
    [createTicketInColumn]
  );

  const handleCreateAndOpenTicketFromColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      position: 'top' | 'bottom',
      options?: BlankTicketCreateOptions
    ) => {
      const { ticketId, targetProjectId } = await createTicketInColumn(
        statusId,
        objective,
        position,
        options
      );
      navigate({
        to: '/projects/$projectId/tickets/$ticketId',
        params: { projectId: targetProjectId, ticketId }
      });
    },
    [createTicketInColumn, navigate]
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

  const isTagFilterActive = selectedTagIds.length > 0;
  const visibleColumns = isTagFilterActive ? filteredColumns : displayColumns;

  const activeTicket = activeId ? ticketById.get(activeId) : undefined;
  const activeAssignee = activeTicket
    ? resolveAssignee(activeTicket, membersByWorkspaceUserId)
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

  const renderBoardColumns = (columnsDraggable: boolean) =>
    statuses.map(status => {
      const colTickets = resolveColumnTickets(visibleColumns[status.id] ?? [], ticketById);
      return (
        <BoardColumn
          key={status.id}
          status={status}
          tickets={colTickets}
          count={colTickets.length}
          draggable={columnsDraggable}
          {...columnProps}
        />
      );
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 min-w-0">
        <ProjectSettingsSection
          projectId={projectId}
          initialName={projectName}
          initialColor={projectColor}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-5 py-3">
          <TicketsViewToggle value={view} onChange={handleViewChange} />
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
          <div className="flex h-full min-h-0 items-stretch gap-4">{renderBoardColumns(false)}</div>
        ) : view === 'board' ? (
          <DndContext {...dndContextProps}>
            <div className="flex h-full min-h-0 items-stretch gap-4">
              {renderBoardColumns(true)}
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
        defaultProjectId={projectId}
      />
    </div>
  );
}
