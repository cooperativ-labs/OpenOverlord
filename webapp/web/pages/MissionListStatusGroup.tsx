import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { type StatusStyle } from '@/components/ui.tsx';
import { cn } from '@/lib/utils';

import type { MissionDto, WorkspaceMemberDto, WorkspaceStatusDto } from '../../shared/contract.ts';

import { resolveAssignee } from './board-shared.ts';
import { MissionListCard } from './MissionListCard.tsx';

export function MissionListStatusGroup({
  status,
  style,
  missions,
  projectId,
  projectName,
  projectColor,
  membersByWorkspaceUserId,
  selectedMissionId,
  isCollapsed,
  onToggleCollapse
}: {
  status: WorkspaceStatusDto;
  style: StatusStyle;
  missions: MissionDto[];
  projectId: string;
  projectName: string;
  projectColor: string | null;
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedMissionId?: string;
  isCollapsed: boolean;
  onToggleCollapse: (statusId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status.id });
  const Icon = style.icon;

  return (
    <section
      className={cn(
        'rounded-lg border border-l-2 border-border bg-card transition-colors',
        style.rail,
        isOver && 'ring-1 ring-inset ring-primary/30'
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-label={isCollapsed ? `Expand ${status.name}` : `Collapse ${status.name}`}
          aria-expanded={!isCollapsed}
          onClick={() => onToggleCollapse(status.id)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <span
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded',
            style.bg,
            style.text
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className={cn('text-sm font-medium', style.text)}>{status.name}</span>
        <span className="text-xs text-muted-foreground">{missions.length}</span>
      </div>

      {isCollapsed ? null : (
        <div
          ref={setNodeRef}
          className={cn('flex min-h-12 flex-col gap-0.5 p-1', isOver && 'bg-muted/30')}
        >
          <SortableContext items={missions.map(t => t.id)} strategy={verticalListSortingStrategy}>
            {missions.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">No missions in this status.</p>
            ) : (
              missions.map(mission => (
                <MissionListCard
                  key={mission.id}
                  mission={mission}
                  projectId={projectId}
                  projectName={projectName}
                  projectColor={projectColor}
                  assignee={resolveAssignee(mission, membersByWorkspaceUserId)}
                  selected={mission.id === selectedMissionId}
                />
              ))
            )}
          </SortableContext>
        </div>
      )}
    </section>
  );
}
