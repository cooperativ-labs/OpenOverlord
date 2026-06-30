import { Check } from 'lucide-react';

import { AuthenticatedAvatarImage, Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

import type { WorkspaceMemberDto } from '../../shared/contract.ts';

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const value = hex.trim().replace('#', '');
  if (value.length === 3) {
    return {
      r: parseInt(value[0] + value[0], 16),
      g: parseInt(value[1] + value[1], 16),
      b: parseInt(value[2] + value[2], 16)
    };
  }
  if (value.length === 6) {
    return {
      r: parseInt(value.slice(0, 2), 16),
      g: parseInt(value.slice(2, 4), 16),
      b: parseInt(value.slice(4, 6), 16)
    };
  }
  return null;
}

// Derive a checkbox palette from the project color: a faint tint for the
// unchecked fill, the full color for the checked fill, and a checkmark color
// that stays legible against light or dark project colors.
function missionCheckboxColors(color: string | null | undefined) {
  const accent = color && hexToRgb(color) ? color : 'rgb(113, 113, 122)';
  const rgb = color ? hexToRgb(color) : null;
  const tint = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)` : 'rgba(113, 113, 122, 0.14)';
  const luminance = rgb ? rgb.r * 0.299 + rgb.g * 0.587 + rgb.b * 0.114 : 0;
  const checkColor = luminance > 150 ? '#000000' : '#ffffff';
  return { accent, tint, checkColor };
}

// Replaces the static project-color square in the list row with an interactive
// checkbox tinted in the project color. Clicking an unchecked box marks the
// mission complete; a completed box renders filled with a checkmark.
export function MissionCompleteCheckbox({
  color,
  completed,
  onComplete
}: {
  color: string | null | undefined;
  completed: boolean;
  onComplete?: () => void;
}) {
  const { accent, tint, checkColor } = missionCheckboxColors(color);
  const interactive = Boolean(onComplete) && !completed;

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={completed}
      aria-label={completed ? 'Completed' : 'Mark mission complete'}
      title={completed ? 'Completed' : 'Mark complete'}
      disabled={!interactive}
      onClick={event => {
        event.stopPropagation();
        if (interactive) onComplete?.();
      }}
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
        interactive && 'cursor-pointer'
      )}
      style={{ borderColor: accent, backgroundColor: completed ? accent : tint }}
    >
      <Check
        className={cn(
          'h-3 w-3 transition-opacity',
          completed ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'
        )}
        strokeWidth={3}
        style={{ color: completed ? checkColor : accent }}
      />
    </button>
  );
}

export function ProjectColorDot({
  color,
  name,
  size = 'md'
}: {
  color: string | null | undefined;
  name: string | null | undefined;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeClass =
    size === 'sm'
      ? 'h-2 w-2 rounded-[2px]'
      : size === 'lg'
        ? 'h-4 w-4 rounded-[5px]'
        : 'h-2.5 w-2.5 rounded-[2px]';

  if (color) {
    return (
      <span
        className={cn('block shrink-0 border', sizeClass)}
        style={{ backgroundColor: color, borderColor: color }}
        title={name ?? 'Project'}
      />
    );
  }

  return (
    <span
      className={cn('block shrink-0 border border-muted-foreground/50', sizeClass)}
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
      {assignee.avatarUrl ? (
        <AuthenticatedAvatarImage src={assignee.avatarUrl} alt={label} />
      ) : null}
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
