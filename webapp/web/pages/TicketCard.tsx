import { useNavigate } from '@tanstack/react-router';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { TicketCardBody } from './TicketCardBody.tsx';

export function TicketCard({
  ticket,
  projectId,
  projectName,
  projectColor,
  assignee,
  selected
}: {
  ticket: TicketDto;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  assignee?: WorkspaceMemberDto | null;
  selected?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <Card
      aria-label={`Open ticket: ${ticket.title}`}
      size="sm"
      className={cn(
        'group relative cursor-pointer overflow-hidden rounded-md border-gray-300/60 bg-linear-to-br from-gray-300/5 to-transparent transition-all hover:shadow-md dark:border-gray-700/40',
        selected && 'border-gray-600/60 bg-gray-100/90 dark:border-gray-500/70 dark:bg-gray-900/40'
      )}
      onClick={() =>
        navigate({
          to: '/projects/$projectId/tickets/$ticketId',
          params: { projectId, ticketId: ticket.id }
        })
      }
    >
      {ticket.hasExecutingObjective ? (
        <div className="pointer-events-none absolute inset-0 animate-[shimmer_2s_linear_infinite] bg-[length:200%_100%] bg-linear-to-r from-transparent via-emerald-500/20 to-transparent" />
      ) : null}
      <TicketCardBody
        ticket={ticket}
        projectId={projectId}
        projectName={projectName}
        projectColor={projectColor}
        assignee={assignee}
      />
    </Card>
  );
}
