import { Badge, STATUS_LABEL, statusClasses } from '@/components/ui.tsx';

import type { ProjectStatusDto, TicketDto } from '../../shared/contract.ts';

import type { ColumnMap } from './board-shared.ts';
import { TicketListRow } from './TicketListRow.tsx';

export function TicketListView({
  statuses,
  columns,
  ticketById,
  projectId,
  selectedTicketId
}: {
  statuses: ProjectStatusDto[];
  columns: ColumnMap;
  ticketById: Map<string, TicketDto>;
  projectId: string;
  selectedTicketId?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      {statuses.map(status => {
        const tickets = (columns[status.id] ?? [])
          .map(id => ticketById.get(id))
          .filter((ticket): ticket is TicketDto => ticket !== undefined);

        return (
          <section key={status.id} className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
              <Badge className={statusClasses(status.type)}>
                {status.name}
                <span className="ml-1.5 opacity-60">{STATUS_LABEL[status.type]}</span>
              </Badge>
              <span className="text-xs text-muted-foreground">{tickets.length}</span>
            </div>
            {tickets.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">No tickets in this status.</p>
            ) : (
              <div className="divide-y divide-border p-1">
                {tickets.map(ticket => (
                  <TicketListRow
                    key={ticket.id}
                    ticket={ticket}
                    projectId={projectId}
                    statuses={statuses}
                    selected={ticket.id === selectedTicketId}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
