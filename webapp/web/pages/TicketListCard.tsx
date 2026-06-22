import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from '@tanstack/react-router';
import { GripVertical } from 'lucide-react';

import { Badge, priorityClasses } from '@/components/ui.tsx';
import { cn } from '@/lib/utils';

import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { getTicketTags } from './board-shared.ts';
import { ProjectColorDot, TicketAssigneeAvatar } from './TicketCardPrimitives.tsx';

export function TicketListCard({
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
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: ticket.id, disabled: isDragOverlay });

  const tags = getTicketTags(ticket);

  const openTicket = () =>
    navigate({
      to: '/projects/$projectId/tickets/$ticketId',
      params: { projectId, ticketId: ticket.id }
    });

  return (
    <div
      ref={isDragOverlay ? undefined : setNodeRef}
      style={
        isDragOverlay ? undefined : { transform: CSS.Transform.toString(transform), transition }
      }
      role="button"
      tabIndex={0}
      aria-label={`Open ${ticket.displayId}: ${ticket.title}`}
      onClick={openTicket}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openTicket();
        }
      }}
      className={cn(
        'group relative flex cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isDragging && 'opacity-40',
        isDragOverlay && 'border-border bg-card shadow-lg',
        selected && 'border-border bg-primary/10 ring-1 ring-inset ring-primary/30'
      )}
    >
      {/* Drag handle — activates dnd-kit reorder/move without triggering navigation. */}
      <span
        ref={isDragOverlay ? undefined : setActivatorNodeRef}
        {...(isDragOverlay ? {} : listeners)}
        aria-label="Drag to reorder"
        onClick={event => event.stopPropagation()}
        className="flex h-4 w-3 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>

      <ProjectColorDot color={projectColor} name={projectName} size="sm" />

      {/* Title + tags */}
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-snug text-foreground">
          {ticket.title}
        </span>
        {tags.length > 0 ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {tags.map(tag => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground"
                style={
                  tag.color ? { backgroundColor: `${tag.color}22`, color: tag.color } : undefined
                }
              >
                {tag.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Right metadata row */}
      <div className="flex shrink-0 items-center gap-2">
        <span
          className="font-mono text-[10px] tabular-nums text-muted-foreground"
          title={`Ticket ID: ${ticket.displayId}`}
        >
          {ticket.displayId}
        </span>
        <span className="hidden text-[10px] text-muted-foreground sm:inline">
          {ticket.completedObjectiveCount} obj
          {ticket.completedObjectiveCount === 1 ? '' : 's'}
        </span>
        {ticket.priority ? (
          <Badge className={priorityClasses(ticket.priority)}>{ticket.priority}</Badge>
        ) : null}
        <TicketAssigneeAvatar assignee={assignee} />
      </div>
    </div>
  );
}
