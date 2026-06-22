import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { useState } from 'react';

import { NewTicketModal } from '@/components/NewTicketModal.tsx';
import { Badge, STATUS_CONFIG, statusClasses } from '@/components/ui.tsx';
import { readLastUsedProjectId } from '@/lib/last-used-project.ts';

import type { MyTicketDto, StatusType, WorkspaceMemberDto } from '../../shared/contract.ts';

import { resolveAssignee } from './board-shared.ts';
import { SortableTicketCard } from './SortableTicketCard.tsx';
import { TicketCard } from './TicketCard.tsx';

/**
 * One column of the My Tickets aggregate board. Unlike the project `BoardColumn`
 * it spans projects, so its "Add ticket" affordance opens the full `NewTicketModal`
 * (project picker included) defaulting to the last-used project, rather than the
 * board's inline `BlankTicketCard`. Its cards open the workspace-scoped ticket
 * route. `type === null` renders the synthetic "Uncategorized" bucket for tickets
 * whose status is no longer an active workspace column — it has no real status id
 * to create into, so it gets no "Add ticket" affordance.
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
  const [isAddingTicket, setIsAddingTicket] = useState(false);

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
      {type ? (
        <button
          type="button"
          onClick={() => setIsAddingTicket(true)}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-muted-foreground/20 py-2 text-xs text-muted-foreground/40 transition-colors hover:border-muted-foreground/40 hover:text-muted-foreground/70"
        >
          <Plus className="h-3 w-3" />
          Add ticket
        </button>
      ) : null}
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
      {type ? (
        <NewTicketModal
          open={isAddingTicket}
          onClose={() => setIsAddingTicket(false)}
          defaultProjectId={readLastUsedProjectId()}
          defaultStatusId={droppableId}
        />
      ) : null}
    </div>
  );
}
