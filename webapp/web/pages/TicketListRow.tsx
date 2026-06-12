import { useNavigate } from '@tanstack/react-router';

import { Badge, priorityClasses, Select } from '@/components/ui.tsx';
import { useUpdateTicket } from '@/lib/queries.ts';
import { cn } from '@/lib/utils';

import type { ProjectStatusDto, TicketDto } from '../../shared/contract.ts';

export function TicketListRow({
  ticket,
  projectId,
  statuses,
  selected
}: {
  ticket: TicketDto;
  projectId: string;
  statuses: ProjectStatusDto[];
  selected?: boolean;
}) {
  const navigate = useNavigate();
  const update = useUpdateTicket(ticket.id);

  const openTicket = () =>
    navigate({
      to: '/projects/$projectId/tickets/$ticketId',
      params: { projectId, ticketId: ticket.id }
    });

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${ticket.displayId}: ${ticket.title}`}
      className={cn(
        'grid w-full cursor-pointer grid-cols-[minmax(5rem,7rem)_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-3 py-2 text-left transition hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[minmax(5rem,7rem)_minmax(0,1fr)_8rem_9rem_auto]',
        selected && 'bg-primary/10 ring-1 ring-inset ring-primary/30'
      )}
      onClick={openTicket}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openTicket();
        }
      }}
    >
      <span className="font-mono text-xs text-muted-foreground">{ticket.displayId}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">{ticket.title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">
          {ticket.objectiveCount} obj{ticket.objectiveCount === 1 ? '' : 's'}
        </span>
      </span>
      <span className="hidden text-xs text-muted-foreground md:block">
        {ticket.objectiveCount} obj{ticket.objectiveCount === 1 ? '' : 's'}
      </span>
      <span className="hidden md:block">
        {ticket.priority && (
          <Badge className={priorityClasses(ticket.priority)}>{ticket.priority}</Badge>
        )}
      </span>
      <Select
        className="max-w-32 text-xs"
        value={ticket.statusId}
        onPointerDown={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => e.stopPropagation()}
        onChange={e => {
          e.stopPropagation();
          update.mutate({ statusId: e.target.value });
        }}
      >
        {statuses.map(s => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
