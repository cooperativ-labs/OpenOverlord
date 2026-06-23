import { ArrowRightToLine, EllipsisVertical } from 'lucide-react';

import { CopyMissionIdentifierButton } from '@/components/CopyMissionIdentifierButton';
import { DeleteMissionButton } from '@/components/DeleteMissionButton';
import { MissionMemberSelect } from '@/components/MissionMemberSelect';
import { MissionProjectSelect } from '@/components/MissionProjectSelect';
import { MissionStatusSelect } from '@/components/MissionStatusSelect';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';

import type { MissionDetailDto } from '../../shared/contract.ts';

type MissionPanelHeaderProps = {
  mission: MissionDetailDto;
  projectId: string;
  onClose: () => void;
  onProjectChanged?: (projectId: string) => void;
};

export function MissionPanelHeader({
  mission,
  projectId,
  onClose,
  onProjectChanged
}: MissionPanelHeaderProps) {
  return (
    <div className="relative flex shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-[var(--color-border)] px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="Mission actions"
                className="h-7 w-7"
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
              <span>
                Mission ID: <strong>{mission.displayId}</strong>
              </span>
              <CopyMissionIdentifierButton
                value={mission.displayId}
                ariaLabel="Copy full mission identifier"
                className="inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-accent"
              />
            </div>
            <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
              <span>Delete mission</span>
              <DeleteMissionButton
                missionId={mission.id}
                projectId={projectId}
                missionLabel={mission.displayId}
                className="inline-flex h-7 w-7 items-center justify-center"
              />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="truncate text-xs tabular-nums text-muted-foreground">
          {mission.displayId}
        </span>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-3">
        <div className="flex items-center gap-1.5">
          <MissionMemberSelect
            missionId={mission.id}
            workspaceId={mission.workspaceId}
            assignedWorkspaceUserId={mission.assignedWorkspaceUserId}
          />
          <MissionProjectSelect
            missionId={mission.id}
            projectId={projectId}
            onProjectChanged={onProjectChanged}
          />
          <MissionStatusSelect
            missionId={mission.id}
            currentStatusId={mission.statusId}
            statuses={mission.statuses}
          />
        </div>

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="h-7 w-7"
          aria-label="Close panel"
          onClick={onClose}
        >
          <ArrowRightToLine className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
