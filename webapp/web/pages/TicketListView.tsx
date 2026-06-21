import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useCallback, useMemo, useState } from 'react';

import { STATUS_CONFIG } from '@/components/ui.tsx';

import type { TicketDto, WorkspaceMemberDto, WorkspaceStatusDto } from '../../shared/contract.ts';

import { type ColumnMap, resolveAssignee, resolveColumnTickets } from './board-shared.ts';
import { TicketListCard } from './TicketListCard.tsx';
import { TicketListStatusGroup } from './TicketListStatusGroup.tsx';
import { useBoardColumnDnd } from './useBoardColumnDnd.ts';

export function TicketListView({
  statuses,
  columns,
  ticketById,
  projectId,
  projectName,
  projectColor,
  membersByWorkspaceUserId,
  selectedTicketId,
  draggable = true
}: {
  statuses: WorkspaceStatusDto[];
  columns: ColumnMap;
  ticketById: Map<string, TicketDto>;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedTicketId?: string;
  draggable?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const { activeId, displayColumns, dndContextProps } = useBoardColumnDnd({
    columns,
    statuses,
    projectId,
    draggable
  });

  const toggleCollapse = useCallback((statusId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(statusId)) next.delete(statusId);
      else next.add(statusId);
      return next;
    });
  }, []);

  const activeTicket = activeId ? ticketById.get(activeId) : undefined;
  const activeAssignee = activeTicket
    ? resolveAssignee(activeTicket, membersByWorkspaceUserId)
    : undefined;

  const groups = useMemo(
    () =>
      statuses.map(status => ({
        status,
        tickets: resolveColumnTickets(displayColumns[status.id] ?? [], ticketById)
      })),
    [statuses, displayColumns, ticketById]
  );

  return (
    <DndContext {...dndContextProps}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
        {groups.map(({ status, tickets }) => (
          <TicketListStatusGroup
            key={status.id}
            status={status}
            style={STATUS_CONFIG[status.type]}
            tickets={tickets}
            projectId={projectId}
            projectName={projectName}
            projectColor={projectColor}
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedTicketId={selectedTicketId}
            isCollapsed={collapsed.has(status.id)}
            onToggleCollapse={toggleCollapse}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTicket ? (
          <TicketListCard
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
  );
}
