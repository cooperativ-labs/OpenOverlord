import { useNavigate } from '@tanstack/react-router';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { TicketCardBody } from './TicketCardBody.tsx';
import { getTicketCardState } from './ticketCardState.ts';
import { TicketCardStateOverlay } from './TicketCardStateOverlay.tsx';

/**
 * The clickable card chrome shared by the static (`TicketCard`) and sortable
 * (`SortableTicketCard`) board cards: the bordered `Card`, the derived
 * state overlay, the body, and the navigate-to-ticket click handler. Keeping
 * this in one place means both card variants stay visually in sync.
 */
export function TicketCardSurface({
  ticket,
  projectId,
  projectName,
  projectColor,
  assignee,
  selected,
  size,
  className,
  onOpen
}: {
  ticket: TicketDto;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  assignee?: WorkspaceMemberDto | null;
  selected?: boolean;
  size?: 'default' | 'sm';
  className?: string;
  /** Override the default navigate-to-project-ticket click (e.g. the My Tickets board). */
  onOpen?: () => void;
}) {
  const navigate = useNavigate();
  const cardState = getTicketCardState(ticket);

  return (
    <Card
      aria-label={`Open ticket: ${ticket.title}`}
      size={size}
      className={cn(
        'group relative overflow-hidden rounded-md border-gray-300/60 bg-linear-to-br from-gray-300/5 to-transparent transition-all hover:shadow-md dark:border-gray-700/40',
        selected && 'border-gray-600/60 bg-gray-100/90 dark:border-gray-500/70 dark:bg-gray-900/40',
        className
      )}
      onClick={() =>
        onOpen
          ? onOpen()
          : navigate({
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
  );
}
