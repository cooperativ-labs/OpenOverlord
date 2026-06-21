import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useMatch, useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { MyTicketDto, WorkspaceMemberDto, WorkspaceStatusDto } from '../../shared/contract.ts';
import { EmptyState, Spinner } from '../components/ui.tsx';
import { ApiRequestError } from '../lib/api.ts';
import {
  useMeta,
  useWorkspaceMembers,
  useWorkspaceMyTickets,
  useWorkspaceStatuses
} from '../lib/queries.ts';

import { type BoardView, type ColumnMap, resolveColumnTickets } from './board-shared.ts';
import { MyTicketsColumn } from './MyTicketsColumn.tsx';
import { SortableTicketCard } from './SortableTicketCard.tsx';
import { TicketsViewToggle } from './TicketsViewToggle.tsx';
import { useMyTicketsDnd } from './useMyTicketsDnd.ts';

const UNCATEGORIZED_ID = '__my_tickets_uncategorized__';
const VIEW_STORAGE_KEY = 'overlord:my-tickets-view';

function readStoredView(): BoardView {
  if (typeof window === 'undefined') return 'board';
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function storeView(view: BoardView) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Ignore private-mode/quota failures; the toggle still works in memory.
  }
}

function describeReorderError(
  status: WorkspaceStatusDto,
  error: unknown,
  workspaceName: string
): string {
  if (error instanceof ApiRequestError && error.code === 'STATUS_UNAVAILABLE_FOR_WORKSPACE') {
    return `“${status.name}” is not available for tickets in the ${workspaceName} workspace.`;
  }
  return error instanceof Error ? error.message : 'Could not move the ticket.';
}

export function MyTicketsPage() {
  const navigate = useNavigate();
  const meta = useMeta();
  const statusesQ = useWorkspaceStatuses();
  const myTicketsQ = useWorkspaceMyTickets();

  const ticketMatch = useMatch({ from: '/workspace/tickets/$ticketId', shouldThrow: false });
  const selectedTicketId = ticketMatch?.params.ticketId;

  const workspaceId = meta.data?.workspace.id ?? null;
  const workspaceName = meta.data?.workspace.name ?? 'this';
  const membersQ = useWorkspaceMembers(workspaceId);

  const [view, setView] = useState<BoardView>(() => readStoredView());
  const [alert, setAlert] = useState<string | null>(null);

  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);
  const tickets = useMemo(() => myTicketsQ.data?.tickets ?? [], [myTicketsQ.data]);

  const membersByWorkspaceUserId = useMemo(() => {
    const map = new Map<string, WorkspaceMemberDto>();
    for (const member of membersQ.data ?? []) map.set(member.workspaceUserId, member);
    return map;
  }, [membersQ.data]);

  const ticketById = useMemo(() => {
    const map = new Map<string, MyTicketDto>();
    for (const t of tickets) map.set(t.id, t);
    return map;
  }, [tickets]);

  // Server returns merge order (positioned first, then fallback); preserve it per
  // column. Any ticket whose status is no longer an active workspace column falls
  // into the Uncategorized bucket.
  const { baseColumns, uncategorized } = useMemo(() => {
    const statusIds = new Set(statuses.map(s => s.id));
    const cols: ColumnMap = {};
    for (const s of statuses) cols[s.id] = [];
    const unmatched: string[] = [];
    for (const t of tickets) {
      if (statusIds.has(t.statusId)) (cols[t.statusId] ??= []).push(t.id);
      else unmatched.push(t.id);
    }
    return { baseColumns: cols, uncategorized: unmatched };
  }, [statuses, tickets]);

  const columnsForDnd = useMemo<ColumnMap>(() => {
    const cols: ColumnMap = { ...baseColumns };
    if (uncategorized.length > 0) cols[UNCATEGORIZED_ID] = uncategorized;
    return cols;
  }, [baseColumns, uncategorized]);

  const onReorderError = useCallback(
    (status: WorkspaceStatusDto, error: unknown) => {
      setAlert(describeReorderError(status, error, workspaceName));
    },
    [workspaceName]
  );

  const { activeId, displayColumns, dndContextProps } = useMyTicketsDnd({
    columns: columnsForDnd,
    statuses,
    onReorderError
  });

  const handleViewChange = (next: BoardView) => {
    setView(next);
    storeView(next);
  };

  const openTicket = useCallback(
    (ticketId: string) => {
      void navigate({ to: '/workspace/tickets/$ticketId', params: { ticketId } });
    },
    [navigate]
  );

  // Drop a stale alert once the underlying data refetches.
  useEffect(() => {
    if (!alert) return;
    const timer = window.setTimeout(() => setAlert(null), 6000);
    return () => window.clearTimeout(timer);
  }, [alert]);

  if (statusesQ.isLoading || myTicketsQ.isLoading) {
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  }
  if (myTicketsQ.isError) {
    return (
      <div className="p-8 text-sm text-red-400">
        Could not load your tickets: {(myTicketsQ.error as Error).message}
      </div>
    );
  }

  const activeTicket = activeId ? ticketById.get(activeId) : undefined;

  const renderColumns = (draggable: boolean) => (
    <>
      {statuses.map(status => {
        const colTickets = resolveColumnTickets(displayColumns[status.id] ?? [], ticketById);
        return (
          <MyTicketsColumn
            key={status.id}
            droppableId={status.id}
            title={status.name}
            type={status.type}
            tickets={colTickets}
            count={colTickets.length}
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedTicketId={selectedTicketId}
            draggable={draggable}
            onOpenTicket={openTicket}
          />
        );
      })}
      {uncategorized.length > 0 ? (
        <MyTicketsColumn
          droppableId={UNCATEGORIZED_ID}
          title="Uncategorized"
          type={null}
          tickets={resolveColumnTickets(displayColumns[UNCATEGORIZED_ID] ?? [], ticketById)}
          count={(displayColumns[UNCATEGORIZED_ID] ?? []).length}
          membersByWorkspaceUserId={membersByWorkspaceUserId}
          selectedTicketId={selectedTicketId}
          draggable={draggable}
          onOpenTicket={openTicket}
        />
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-5 py-3">
          <h1 className="text-sm font-semibold">My Tickets</h1>
          <TicketsViewToggle value={view} onChange={handleViewChange} />
        </div>
        {alert ? (
          <div className="flex items-start justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-sm text-amber-700 dark:text-amber-300">
            <span>{alert}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
              onClick={() => setAlert(null)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tickets.length === 0 ? (
          <EmptyState
            title="No tickets are assigned to you"
            hint="Tickets assigned to you across this workspace's projects show up here, grouped by status."
          />
        ) : view === 'board' ? (
          <DndContext {...dndContextProps}>
            <div className="flex h-full min-h-0 items-stretch gap-4">{renderColumns(true)}</div>
            <DragOverlay>
              {activeTicket ? (
                <SortableTicketCard
                  ticket={activeTicket}
                  projectId={activeTicket.projectId}
                  projectName={activeTicket.projectName}
                  projectColor={activeTicket.projectColor}
                  assignee={
                    activeTicket.assignedWorkspaceUserId
                      ? membersByWorkspaceUserId.get(activeTicket.assignedWorkspaceUserId)
                      : undefined
                  }
                  selected={activeTicket.id === selectedTicketId}
                  isDragOverlay
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <div className="flex flex-col gap-6">{renderColumns(false)}</div>
        )}
      </div>
    </div>
  );
}
