import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from '@tanstack/react-router';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { TicketCardBody } from './TicketCardBody.tsx';
import { getTicketCardState } from './ticketCardState.ts';
import { TicketCardStateOverlay } from './TicketCardStateOverlay.tsx';

export function SortableTicketCard({
  ticket,
  projectId,
  projectName,
  projectColor,
  assignee,
  selected,
  isDragOverlay
}: {
  ticket: TicketDto;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  assignee?: WorkspaceMemberDto | null;
  selected?: boolean;
  isDragOverlay?: boolean;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    disabled: isDragOverlay
  });
  const cardState = getTicketCardState(ticket);

  if (isDragOverlay) {
    return (
      <div className="w-full rounded-md border border-dashed border-primary/40 bg-card shadow-lg">
        <TicketCardBody
          ticket={ticket}
          projectId={projectId}
          projectName={projectName}
          projectColor={projectColor}
          assignee={assignee}
          cardState={cardState}
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
      <Card
        aria-label={`Open ticket: ${ticket.title}`}
        className={cn(
          'group relative overflow-hidden rounded-md border-gray-300/60 bg-linear-to-br from-gray-300/5 to-transparent transition-all hover:shadow-md dark:border-gray-700/40',
          selected &&
            'border-gray-600/60 bg-gray-100/90 dark:border-gray-500/70 dark:bg-gray-900/40'
        )}
        onClick={() =>
          navigate({
            to: '/projects/$projectId/tickets/$ticketId',
            params: { projectId, ticketId: ticket.id }
          })
        }
      >
        <TicketCardStateOverlay state={cardState} />
        <TicketCardBody
          ticket={ticket}
          projectId={projectId}
          projectName={projectName}
          projectColor={projectColor}
          assignee={assignee}
          cardState={cardState}
        />
      </Card>
    </div>
  );
}
