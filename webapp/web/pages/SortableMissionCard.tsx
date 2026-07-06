import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { cn } from '@/lib/utils';

import type { MissionDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { MissionCardBody } from './MissionCardBody.tsx';
import { getMissionCardState } from './missionCardState.ts';
import { MissionCardSurface } from './MissionCardSurface.tsx';

export function SortableMissionCard({
  mission,
  projectId,
  projectName,
  projectColor,
  assignee,
  selected,
  isDragOverlay,
  disabled,
  onOpen
}: {
  mission: MissionDto;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  assignee?: WorkspaceMemberDto | null;
  selected?: boolean;
  isDragOverlay?: boolean;
  disabled?: boolean;
  /** Override the default navigate-to-project-mission click (e.g. the My Missions board). */
  onOpen?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: mission.id,
    disabled: isDragOverlay || disabled
  });

  if (isDragOverlay) {
    return (
      <div className="w-full rounded-md border border-dashed pt-2 border-primary/40 bg-card shadow-lg">
        <MissionCardBody
          mission={mission}
          projectId={projectId}
          projectName={projectName}
          projectColor={projectColor}
          assignee={assignee}
          cardState={getMissionCardState(mission)}
        />
      </div>
    );
  }

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'shrink-0',
        disabled ? 'cursor-pointer' : 'cursor-grab touch-none active:cursor-grabbing',
        isDragging && 'opacity-40'
      )}
      {...(disabled ? {} : listeners)}
      {...(disabled ? {} : attributes)}
    >
      <MissionCardSurface
        mission={mission}
        projectId={projectId}
        projectName={projectName}
        projectColor={projectColor}
        assignee={assignee}
        selected={selected}
        onOpen={onOpen}
      />
    </div>
  );
}
