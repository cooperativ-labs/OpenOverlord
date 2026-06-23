import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { useState } from 'react';

import { NewMissionModal } from '@/components/NewMissionModal.tsx';
import { Badge, STATUS_CONFIG, statusClasses } from '@/components/ui.tsx';
import { readLastUsedProjectId } from '@/lib/last-used-project.ts';

import type { MyMissionDto, StatusType, WorkspaceMemberDto } from '../../shared/contract.ts';

import { resolveAssignee } from './board-shared.ts';
import { MissionCard } from './MissionCard.tsx';
import { SortableMissionCard } from './SortableMissionCard.tsx';

/**
 * One column of the My Missions aggregate board. Unlike the project `BoardColumn`
 * it spans projects, so its "Add mission" affordance opens the full `NewMissionModal`
 * (project picker included) defaulting to the last-used project, rather than the
 * board's inline `BlankMissionCard`. Its cards open the workspace-scoped mission
 * route. `type === null` renders the synthetic "Uncategorized" bucket for missions
 * whose status is no longer an active workspace column — it has no real status id
 * to create into, so it gets no "Add mission" affordance.
 */
export function MyMissionsColumn({
  droppableId,
  title,
  type,
  missions,
  count,
  membersByWorkspaceUserId,
  selectedMissionId,
  draggable = true,
  onOpenMission
}: {
  droppableId: string;
  title: string;
  type: StatusType | null;
  missions: MyMissionDto[];
  count: number;
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedMissionId?: string;
  draggable?: boolean;
  onOpenMission: (missionId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });
  const StatusIcon = type ? STATUS_CONFIG[type].icon : null;
  const [isAddingMission, setIsAddingMission] = useState(false);

  const content = (
    <div
      ref={setNodeRef}
      className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1 transition-colors ${
        isOver
          ? 'bg-[var(--color-surface-2)]/40 ring-1 ring-inset ring-[var(--color-accent)]/30'
          : ''
      }`}
    >
      {missions.map(mission => {
        const assignee = resolveAssignee(mission, membersByWorkspaceUserId);
        const cardProps = {
          mission,
          projectId: mission.projectId,
          projectName: mission.projectName,
          projectColor: mission.projectColor,
          assignee,
          selected: mission.id === selectedMissionId,
          onOpen: () => onOpenMission(mission.id)
        };

        return draggable ? (
          <SortableMissionCard key={mission.id} {...cardProps} />
        ) : (
          <MissionCard key={mission.id} {...cardProps} />
        );
      })}
      {type ? (
        <button
          type="button"
          onClick={() => setIsAddingMission(true)}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-muted-foreground/20 py-2 text-xs text-muted-foreground/40 transition-colors hover:border-muted-foreground/40 hover:text-muted-foreground/70"
        >
          <Plus className="h-3 w-3" />
          Add mission
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-72 shrink-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between px-1">
        <Badge className={type ? statusClasses(type) : 'bg-muted text-muted-foreground'}>
          {title}
          {StatusIcon ? <StatusIcon className="ml-1.5 h-3 w-3 opacity-60" /> : null}
        </Badge>
        <span className="text-xs text-[var(--color-ink-dim)]">{count}</span>
      </div>
      {draggable ? (
        <SortableContext items={missions.map(t => t.id)} strategy={verticalListSortingStrategy}>
          {content}
        </SortableContext>
      ) : (
        content
      )}
      {type ? (
        <NewMissionModal
          open={isAddingMission}
          onClose={() => setIsAddingMission(false)}
          defaultProjectId={readLastUsedProjectId()}
          defaultStatusId={droppableId}
        />
      ) : null}
    </div>
  );
}
