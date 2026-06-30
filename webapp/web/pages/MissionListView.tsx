import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useCallback, useMemo, useState } from 'react';

import { STATUS_CONFIG } from '@/components/ui.tsx';

import type { MissionDto, WorkspaceMemberDto, WorkspaceStatusDto } from '../../shared/contract.ts';

import { type BlankMissionCreateOptions } from './BlankMissionCard.tsx';
import { type ColumnMap, resolveAssignee, resolveColumnMissions } from './board-shared.ts';
import { MissionListCard } from './MissionListCard.tsx';
import { MissionListStatusGroup } from './MissionListStatusGroup.tsx';
import { useBoardColumnDnd } from './useBoardColumnDnd.ts';

export function MissionListView({
  statuses,
  columns,
  missionById,
  projectId,
  projectName,
  projectColor,
  membersByWorkspaceUserId,
  selectedMissionId,
  draggable = true,
  onCreateMission,
  onCreateAndOpenMission,
  onCompleteMission
}: {
  statuses: WorkspaceStatusDto[];
  columns: ColumnMap;
  missionById: Map<string, MissionDto>;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedMissionId?: string;
  draggable?: boolean;
  onCreateMission?: (
    statusId: string,
    objective: string,
    position: 'top' | 'bottom',
    options?: BlankMissionCreateOptions
  ) => Promise<void> | void;
  onCreateAndOpenMission?: (
    statusId: string,
    objective: string,
    position: 'top' | 'bottom',
    options?: BlankMissionCreateOptions
  ) => Promise<void> | void;
  onCompleteMission?: (missionId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const { activeId, displayColumns, dndContextProps } = useBoardColumnDnd({
    columns,
    statuses,
    projectId,
    draggable
  });

  const toggleCollapse = useCallback((statusId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(statusId)) next.delete(statusId);
      else next.add(statusId);
      return next;
    });
  }, []);

  const activeMission = activeId ? missionById.get(activeId) : undefined;
  const activeAssignee = activeMission
    ? resolveAssignee(activeMission, membersByWorkspaceUserId)
    : undefined;

  const groups = useMemo(
    () =>
      statuses.map(status => ({
        status,
        missions: resolveColumnMissions(displayColumns[status.id] ?? [], missionById)
      })),
    [statuses, displayColumns, missionById]
  );

  return (
    <DndContext {...dndContextProps}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
        {groups.map(({ status, missions }) => (
          <MissionListStatusGroup
            key={status.id}
            status={status}
            style={STATUS_CONFIG[status.type]}
            missions={missions}
            projectId={projectId}
            projectName={projectName}
            projectColor={projectColor}
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedMissionId={selectedMissionId}
            isCollapsed={collapsed.has(status.id)}
            onToggleCollapse={toggleCollapse}
            onCreateMission={onCreateMission}
            onCreateAndOpenMission={onCreateAndOpenMission}
            onCompleteMission={onCompleteMission}
          />
        ))}
      </div>
      <DragOverlay>
        {activeMission ? (
          <MissionListCard
            mission={activeMission}
            projectId={projectId}
            projectName={projectName}
            projectColor={projectColor}
            assignee={activeAssignee}
            selected={activeMission.id === selectedMissionId}
            isDragOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
