import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useCallback, useMemo, useState } from 'react';

import { STATUS_CONFIG, UNCATEGORIZED_STATUS_STYLE } from '@/components/ui.tsx';

import type { MissionDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { type BlankMissionCreateOptions } from './BlankMissionCard.tsx';
import { type BoardDndResult, resolveAssignee, resolveColumnMissions } from './board-shared.ts';
import type { BoardColumnStatus, MissionCardContext } from './BoardColumn.tsx';
import { MissionListCard } from './MissionListCard.tsx';
import { MissionListStatusGroup } from './MissionListStatusGroup.tsx';

export function MissionListView<TMission extends MissionDto = MissionDto>({
  statuses,
  dnd,
  missionById,
  projectId,
  projectName,
  projectColor,
  createProjectId = projectId,
  createStatusScope = 'project',
  membersByWorkspaceUserId,
  selectedMissionId,
  getMissionCardContext,
  onCreateMission,
  onCreateAndOpenMission,
  onCompleteMission
}: {
  statuses: BoardColumnStatus[];
  /**
   * Drag state owned by the page, from `useBoardColumnDnd` (project board,
   * project-scoped reorder) or `useMyMissionsDnd` (My Missions, workspace-scoped
   * reorder across projects) — see `BoardDndResult`.
   */
  dnd: BoardDndResult;
  missionById: Map<string, TMission>;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  createProjectId?: string;
  createStatusScope?: 'project' | 'workspace';
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedMissionId?: string;
  getMissionCardContext?: (mission: TMission) => MissionCardContext;
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
  const { activeId, displayColumns, dndContextProps } = dnd;

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

  const activeCardContext = activeMission
    ? (getMissionCardContext?.(activeMission) ?? { projectId, projectName, projectColor })
    : undefined;

  return (
    <DndContext {...dndContextProps}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
        {groups.map(({ status, missions }) => (
          <MissionListStatusGroup
            key={status.id}
            status={status}
            style={status.type ? STATUS_CONFIG[status.type] : UNCATEGORIZED_STATUS_STYLE}
            missions={missions}
            projectId={projectId}
            projectName={projectName}
            projectColor={projectColor}
            createProjectId={createProjectId}
            createStatusScope={createStatusScope}
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedMissionId={selectedMissionId}
            isCollapsed={collapsed.has(status.id)}
            onToggleCollapse={toggleCollapse}
            getMissionCardContext={getMissionCardContext}
            onCreateMission={onCreateMission}
            onCreateAndOpenMission={onCreateAndOpenMission}
            onCompleteMission={onCompleteMission}
          />
        ))}
      </div>
      <DragOverlay>
        {activeMission && activeCardContext ? (
          <MissionListCard
            mission={activeMission}
            projectId={activeCardContext.projectId}
            projectName={activeCardContext.projectName}
            projectColor={activeCardContext.projectColor}
            assignee={activeAssignee}
            selected={activeMission.id === selectedMissionId}
            isDragOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
