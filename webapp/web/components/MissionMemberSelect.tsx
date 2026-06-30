import { Avatar, AvatarFallback, AuthenticatedAvatarImage } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { useUpdateMission, useWorkspaceMembers } from '@/lib/queries.ts';

import type { WorkspaceMemberDto } from '../../shared/contract.ts';

const UNASSIGNED_VALUE = '__unassigned__';

type MissionMemberSelectProps = {
  missionId: string;
  workspaceId: string;
  assignedWorkspaceUserId: string | null;
};

function memberLabel(member: WorkspaceMemberDto): string {
  return member.displayName?.trim() || member.email || 'Member';
}

function memberInitials(member: WorkspaceMemberDto): string {
  return memberLabel(member).slice(0, 2).toUpperCase();
}

function MemberAvatar({ member }: { member: WorkspaceMemberDto }) {
  return (
    <Avatar className="h-4 w-4">
      {member.avatarUrl ? (
        <AuthenticatedAvatarImage src={member.avatarUrl} alt={memberLabel(member)} />
      ) : null}
      <AvatarFallback className="rounded-full text-[8px]">{memberInitials(member)}</AvatarFallback>
    </Avatar>
  );
}

function MemberOptionLabel({ member }: { member: WorkspaceMemberDto | null }) {
  if (!member) {
    return <span>Unassigned</span>;
  }

  return (
    <span className="inline-flex items-center gap-2">
      <MemberAvatar member={member} />
      <span>{memberLabel(member)}</span>
    </span>
  );
}

export function MissionMemberSelect({
  missionId,
  workspaceId,
  assignedWorkspaceUserId
}: MissionMemberSelectProps) {
  const membersQ = useWorkspaceMembers(workspaceId);
  const update = useUpdateMission(missionId);

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
        id="mission-member-select"
        aria-label="Select assignee"
        size="sm"
        className="h-[22px] w-auto rounded-full border-border/50 bg-transparent px-2 text-[11px] font-normal text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground [&_[data-slot=select-value]]:line-clamp-none"
      >
        <span className="inline-grid [&>*]:col-start-1 [&>*]:row-start-1">
          <span className="invisible whitespace-nowrap" aria-hidden>
            <MemberOptionLabel member={null} />
          </span>
          {members.map(member => (
            <span key={member.workspaceUserId} className="invisible whitespace-nowrap" aria-hidden>
              <MemberOptionLabel member={member} />
            </span>
          ))}
          <SelectValue placeholder="Unassigned" className="col-start-1 row-start-1">
            {currentMember ? (
              <MemberOptionLabel member={currentMember} />
            ) : (
              <span className="text-muted-foreground">Unassigned</span>
            )}
          </SelectValue>
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED_VALUE}>
          <MemberOptionLabel member={null} />
        </SelectItem>
        {members.map(member => (
          <SelectItem key={member.workspaceUserId} value={member.workspaceUserId}>
            <MemberOptionLabel member={member} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
