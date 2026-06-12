import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { useUpdateTicket, useWorkspaceMembers } from '@/lib/queries.ts';

import type { WorkspaceMemberDto } from '../../shared/contract.ts';

const UNASSIGNED_VALUE = '__unassigned__';

type TicketMemberSelectProps = {
  ticketId: string;
  workspaceId: string;
  assignedWorkspaceUserId: string | null;
};

function memberLabel(member: WorkspaceMemberDto): string {
  return member.displayName?.trim() || member.handle || member.email || 'Member';
}

function memberInitials(member: WorkspaceMemberDto): string {
  return memberLabel(member).slice(0, 2).toUpperCase();
}

function MemberAvatar({ member }: { member: WorkspaceMemberDto }) {
  return (
    <Avatar className="h-4 w-4">
      {member.avatarUrl ? (
        <AvatarImage src={member.avatarUrl} alt={memberLabel(member)} />
      ) : null}
      <AvatarFallback className="text-[8px]">{memberInitials(member)}</AvatarFallback>
    </Avatar>
  );
}

export function TicketMemberSelect({
  ticketId,
  workspaceId,
  assignedWorkspaceUserId
}: TicketMemberSelectProps) {
  const membersQ = useWorkspaceMembers(workspaceId);
  const update = useUpdateTicket(ticketId);

  const members = membersQ.data ?? [];
  const currentMember = members.find(member => member.workspaceUserId === assignedWorkspaceUserId);
  const selectedValue = assignedWorkspaceUserId ?? UNASSIGNED_VALUE;

  function handleChange(nextValue: string | null) {
    if (!nextValue || nextValue === selectedValue) return;
    const nextMemberId = nextValue === UNASSIGNED_VALUE ? null : nextValue;
    update.mutate({ assignedWorkspaceUserId: nextMemberId });
  }

  return (
    <Select value={selectedValue} disabled={update.isPending} onValueChange={handleChange}>
      <SelectTrigger
        id="ticket-member-select"
        aria-label="Select assignee"
        size="sm"
        className="h-6 w-auto max-w-[10rem] rounded-md border bg-transparent px-2 text-xs font-base hover:bg-muted"
      >
        <SelectValue placeholder="Unassigned">
          {currentMember ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <MemberAvatar member={currentMember} />
              <span className="truncate">{memberLabel(currentMember)}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
        {members.map(member => (
          <SelectItem key={member.workspaceUserId} value={member.workspaceUserId}>
            <span className="inline-flex min-w-0 items-center gap-2">
              <MemberAvatar member={member} />
              <span className="truncate">{memberLabel(member)}</span>
              {member.handle ? (
                <span className="text-muted-foreground">@{member.handle}</span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
