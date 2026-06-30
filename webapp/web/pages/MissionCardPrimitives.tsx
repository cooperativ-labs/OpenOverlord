import { Avatar, AvatarFallback, AuthenticatedAvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

import type { WorkspaceMemberDto } from '../../shared/contract.ts';

export function ProjectColorDot({
  color,
  name,
  size = 'md'
}: {
  color: string | null | undefined;
  name: string | null | undefined;
  size?: 'sm' | 'md';
}) {
  const sizeClass = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';

  if (color) {
    return (
      <span
        className={cn('block shrink-0 rounded-[2px] border', sizeClass)}
        style={{ backgroundColor: color, borderColor: color }}
        title={name ?? 'Project'}
      />
    );
  }

  return (
    <span
      className={cn('block shrink-0 rounded-[2px] border border-muted-foreground/50', sizeClass)}
      title={name ?? 'Project'}
    />
  );
}

function memberLabel(member: WorkspaceMemberDto): string {
  return member.displayName?.trim() || member.handle || member.email || 'Member';
}

function memberInitials(member: WorkspaceMemberDto): string {
  return memberLabel(member).slice(0, 2).toUpperCase();
}

export function MissionAssigneeAvatar({
  assignee
}: {
  assignee: WorkspaceMemberDto | null | undefined;
}) {
  if (!assignee) return null;

  const label = memberLabel(assignee);

  return (
    <Avatar className="h-5 w-5 shrink-0 ring-1 ring-border" title={`Assigned to ${label}`}>
      {assignee.avatarUrl ? <AuthenticatedAvatarImage src={assignee.avatarUrl} alt={label} /> : null}
      <AvatarFallback className="rounded-full text-[8px]">
        {memberInitials(assignee)}
      </AvatarFallback>
    </Avatar>
  );
}

export function MissionAssigneeSummary({
  assignee
}: {
  assignee: WorkspaceMemberDto | null | undefined;
}) {
  if (!assignee) return null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <MissionAssigneeAvatar assignee={assignee} />
    </span>
  );
}
