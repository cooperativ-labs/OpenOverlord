import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';

import { Badge, STATUS_CONFIG, statusClasses } from '@/components/ui.tsx';

import type { MyTicketDto, StatusType, WorkspaceMemberDto } from '../../shared/contract.ts';

import { resolveAssignee } from './board-shared.ts';
import { SortableTicketCard } from './SortableTicketCard.tsx';
import { TicketCard } from './TicketCard.tsx';

/**
 * One column of the My Tickets aggregate board. Unlike the project `BoardColumn`
 * it has no per-project create affordance (the board spans projects) and its
 * cards open the workspace-scoped ticket route. `type === null` renders the
 * synthetic "Uncategorized" bucket for tickets whose status is no longer an
 * active workspace column.
 */
export function MyTicketsColumn({
  droppableId,
  title,
  type,
  tickets,
  count,
  membersByWorkspaceUserId,
  selectedTicketId,
  draggable = true,
  onOpenTicket
}: {
  droppableId: string;
  title: string;
  type: StatusType | null;
  tickets: MyTicketDto[];
  count: number;
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedTicketId?: string;
  draggable?: boolean;
  onOpenTicket: (ticketId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });
  const StatusIcon = type ? STATUS_CONFIG[type].icon : null;

  const content = (
    <div
      ref={setNodeRef}
      className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1 transition-colors ${
        isOver
          ? 'bg-[var(--color-surface-2)]/40 ring-1 ring-inset ring-[var(--color-accent)]/30'
          : ''
      }`}
    >
      {tickets.map(ticket => {
        const assignee = resolveAssignee(ticket, membersByWorkspaceUserId);
        const cardProps = {
          ticket,
          projectId: ticket.projectId,
          projectName: ticket.projectName,
          projectColor: ticket.projectColor,
          assignee,
          selected: ticket.id === selectedTicketId,
          onOpen: () => onOpenTicket(ticket.id)
        };

        return draggable ? (
          <SortableTicketCard key={ticket.id} {...cardProps} />
        ) : (
          <TicketCard key={ticket.id} {...cardProps} />
        );
      })}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-72 shrink-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between px-1">
        <Badge className={type ? statusClasses(type) : 'bg-muted text-muted-foreground'}>
          {title}
          {StatusIcon ? <StatusIcon className="ml-1.5 h-3 w-3 opacity-60" /> : null}
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
