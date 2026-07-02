import type { MissionDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { MissionCardSurface } from './MissionCardSurface.tsx';

export function MissionCard({
  mission,
  projectId,
  projectName,
  projectColor,
  assignee,
  selected,
  onOpen
}: {
  mission: MissionDto;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  assignee?: WorkspaceMemberDto | null;
  selected?: boolean;
  onOpen?: () => void;
}) {
  return (
    <MissionCardSurface
      mission={mission}
      projectId={projectId}
      projectName={projectName}
      projectColor={projectColor}
      assignee={assignee}
      selected={selected}
      size="sm"
      className="cursor-pointer"
      onOpen={onOpen}
    />
  );
}
