import type { MyMissionDto, StatusType, WorkspaceMemberDto } from '../../shared/contract.ts';

import type { BlankMissionCreateOptions } from './BlankMissionCard.tsx';
import { BoardColumn } from './BoardColumn.tsx';

export function MyMissionsColumn({
  droppableId,
  title,
  type,
  missions,
  count,
  defaultProjectId,
  membersByWorkspaceUserId,
  selectedMissionId,
  draggable = true,
  onOpenMission,
  onCreateMission,
  onCreateAndOpenMission
}: {
  droppableId: string;
  title: string;
  type: StatusType | null;
  missions: MyMissionDto[];
  count: number;
  defaultProjectId: string;
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedMissionId?: string;
  draggable?: boolean;
  onOpenMission: (missionId: string) => void;
  onCreateMission: (
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
}) {
  return (
    <BoardColumn
      status={{ id: droppableId, name: title, type }}
      missions={missions}
      count={count}
      projectId={defaultProjectId}
      projectName=""
      projectColor={null}
      createProjectId={defaultProjectId}
      createStatusScope="workspace"
      membersByWorkspaceUserId={membersByWorkspaceUserId}
      selectedMissionId={selectedMissionId}
      draggable={draggable}
      getMissionCardContext={mission => ({
        projectId: mission.projectId,
        projectName: mission.projectName,
        projectColor: mission.projectColor,
        onOpen: () => onOpenMission(mission.id)
      })}
      onCreateMission={onCreateMission}
      onCreateAndOpenMission={onCreateAndOpenMission}
    />
  );
}
