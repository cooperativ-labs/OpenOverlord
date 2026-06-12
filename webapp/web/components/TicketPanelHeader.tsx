import { ArrowRightToLine, EllipsisVertical } from 'lucide-react';

import { CopyTicketIdentifierButton } from '@/components/CopyTicketIdentifierButton';
import { DeleteTicketButton } from '@/components/DeleteTicketButton';
import { TicketMemberSelect } from '@/components/TicketMemberSelect';
import { TicketProjectSelect } from '@/components/TicketProjectSelect';
import { TicketStatusSelect } from '@/components/TicketStatusSelect';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

import type { TicketDetailDto } from '../../shared/contract.ts';

type TicketPanelHeaderProps = {
  ticket: TicketDetailDto;
  projectId: string;
  onClose: () => void;
  onProjectChanged?: (projectId: string) => void;
};

export function TicketPanelHeader({
  ticket,
  projectId,
  onClose,
  onProjectChanged
}: TicketPanelHeaderProps) {
  return (
    <div className="relative flex shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-[var(--color-border)] px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="Ticket actions"
                className="h-7 w-7"
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
              <span>
                Ticket ID: <strong>{ticket.displayId}</strong>
              </span>
              <CopyTicketIdentifierButton
                value={ticket.displayId}
                ariaLabel="Copy full ticket identifier"
                className="inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-accent"
              />
            </div>
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
              <span>Delete ticket</span>
              <DeleteTicketButton
                ticketId={ticket.id}
                projectId={projectId}
                ticketLabel={ticket.displayId}
                className="inline-flex h-7 w-7 items-center justify-center"
              />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="truncate text-xs tabular-nums text-muted-foreground">
          {ticket.displayId}
        </span>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-3">
        <div className="flex items-center gap-1.5">
          <TicketMemberSelect
            ticketId={ticket.id}
            workspaceId={ticket.workspaceId}
            assignedWorkspaceUserId={ticket.assignedWorkspaceUserId}
          />
          <TicketProjectSelect
            ticketId={ticket.id}
            projectId={projectId}
            onProjectChanged={onProjectChanged}
          />
          <TicketStatusSelect
            ticketId={ticket.id}
            currentStatusId={ticket.statusId}
            statuses={ticket.statuses}
          />
        </div>

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-7 w-7"
          aria-label="Close panel"
          onClick={onClose}
        >
          <ArrowRightToLine className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
