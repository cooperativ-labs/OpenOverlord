import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { cn } from '@/lib/utils';

import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { TicketCardBody } from './TicketCardBody.tsx';
import { getTicketCardState } from './ticketCardState.ts';
import { TicketCardSurface } from './TicketCardSurface.tsx';

export function SortableTicketCard({
  ticket,
  projectId,
  projectName,
  projectColor,
  assignee,
  selected,
  isDragOverlay,
  onOpen
}: {
  ticket: TicketDto;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  assignee?: WorkspaceMemberDto | null;
  selected?: boolean;
  isDragOverlay?: boolean;
  /** Override the default navigate-to-project-ticket click (e.g. the My Tickets board). */
  onOpen?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    disabled: isDragOverlay
  });

  if (isDragOverlay) {
    return (
      <div className="w-full rounded-md border border-dashed pt-2 border-primary/40 bg-card shadow-lg">
        <TicketCardBody
          ticket={ticket}
          projectId={projectId}
          projectName={projectName}
          projectColor={projectColor}
          assignee={assignee}
          cardState={getTicketCardState(ticket)}
        />
      </div>
    );
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('cursor-grab touch-none active:cursor-grabbing', isDragging && 'opacity-40')}
      {...listeners}
      {...attributes}
    >
      <TicketCardSurface
        ticket={ticket}
        projectId={projectId}
        projectName={projectName}
        projectColor={projectColor}
        assignee={assignee}
        selected={selected}
        onOpen={onOpen}
      />
    </div>
  );
}
