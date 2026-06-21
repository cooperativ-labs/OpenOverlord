import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { TicketCardSurface } from './TicketCardSurface.tsx';

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
  return (
    <TicketCardSurface
      ticket={ticket}
      projectId={projectId}
      projectName={projectName}
      projectColor={projectColor}
      assignee={assignee}
      selected={selected}
      size="sm"
      className="cursor-pointer"
    />
  );
}
