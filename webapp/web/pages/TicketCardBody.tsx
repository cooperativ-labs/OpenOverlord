import { CardContent } from '@/components/ui/card';

import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { getTicketTags } from './board-shared.ts';
import { TicketCardHoverFooter } from './TicketCardHoverFooter.tsx';
import { ProjectColorDot, TicketAssigneeSummary } from './TicketCardPrimitives.tsx';
import { TicketCardState } from './ticketCardState.ts';
import { cn } from '@/lib/utils.ts';

export function TicketCardBody({
  ticket,
  projectId,
  projectName,
  projectColor,
  assignee,
  cardState
}: {
  ticket: TicketDto;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  assignee?: WorkspaceMemberDto | null;
  cardState: TicketCardState;
}) {
  const tags = getTicketTags(ticket);

  return (
    <CardContent className="flex h-full flex-col p-0 ">
      <div className="px-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium leading-snug text-foreground">{ticket.title}</h4>

          <div className="mt-4 flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <ProjectColorDot color={projectColor} name={projectName} />
              <span className="truncate text-[11px] text-muted-foreground">{projectName}</span>
            </div>
            <div className="flex min-w-0 max-w-[55%] shrink justify-end">
              <TicketAssigneeSummary assignee={assignee} />
              {cardState.objectiveCount > 0 ? (
                <div
                  className={cn(
                    'pointer-events-none absolute bottom-1.5 right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-medium tabular-nums text-white',
                    cardState.objectiveCountAlert ? 'bg-red-500' : 'bg-gray-400 dark:bg-gray-600'
                  )}
                >
                  {cardState.objectiveCount}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className="h-2" />

      <TicketCardHoverFooter
        ticketId={ticket.id}
        projectId={projectId}
        displayId={ticket.displayId}
        tags={tags}
      />
    </CardContent>
  );
}
