import { CardContent } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils.ts';

import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { getTicketTags } from './board-shared.ts';
import { TicketCardHoverFooter } from './TicketCardHoverFooter.tsx';
import { ProjectColorDot, TicketAssigneeSummary } from './TicketCardPrimitives.tsx';
import { TicketCardState } from './ticketCardState.ts';

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
    <CardContent className="flex h-full flex-col p-0 font-body">
      <div className="px-3">
        <div className="min-w-0">
          <h4 className="font-body text-sm font-medium leading-snug text-foreground">
            {ticket.title}
          </h4>

          <div className="mt-4 flex items-end justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <ProjectColorDot color={projectColor} name={projectName} />
              <span className="truncate text-[11px] text-muted-foreground">{projectName}</span>
            </div>
            <div className="flex min-w-0 max-w-[55%] shrink items-center justify-end gap-2">
              {cardState.objectiveCount > 0 ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <div
                        className={cn(
                          'pointer-events-auto flex h-5 min-w-5 items-center justify-center rounded-full text-[11px] font-medium tabular-nums',
                          cardState.objectiveCountAlert
                            ? 'bg-red-500 text-white'
                            : 'bg-muted text-muted-foreground'
                        )}
                        onClick={e => e.stopPropagation()}
                      >
                        {cardState.objectiveCount}
                      </div>
                    }
                  />
                  <TooltipContent>
                    {cardState.objectiveCountAlert
                      ? 'Number of completed objectives in this ticket. Red means an objective has not been submitted.'
                      : 'Number of completed objectives in this ticket.'}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <TicketAssigneeSummary assignee={assignee} />
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
