import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Badge, STATUS_CONFIG, statusClasses } from '@/components/ui.tsx';

import type { MissionDto, WorkspaceMemberDto, WorkspaceStatusDto } from '../../shared/contract.ts';

import { BlankMissionCard, type BlankMissionCreateOptions } from './BlankMissionCard.tsx';
import { resolveAssignee } from './board-shared.ts';
import { SortableMissionCard } from './SortableMissionCard.tsx';
import { MissionCard } from './MissionCard.tsx';

export function BoardColumn({
  status,
  missions,
  count,
  projectId,
  projectName,
  projectColor,
  membersByWorkspaceUserId,
  selectedMissionId,
  draggable = true,
  onCreateMission,
  onCreateAndOpenMission
}: {
  status: WorkspaceStatusDto;
  missions: MissionDto[];
  count: number;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedMissionId?: string;
  draggable?: boolean;
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
  const { setNodeRef, isOver } = useDroppable({ id: status.id });
  const StatusIcon = STATUS_CONFIG[status.type].icon;
  const [isAddingBottom, setIsAddingBottom] = useState(false);
  const [isAddingTop, setIsAddingTop] = useState(false);
  const [focusEditorCount, setFocusEditorCount] = useState(0);
  const [topFocusEditorCount, setTopFocusEditorCount] = useState(0);
  const inputId = `board-column-input-${status.id}`;
  const topInputId = `board-column-input-top-${status.id}`;

  // The BlankMissionCard scrolls itself into view once it mounts (see its
  // scroll-into-view effect), so opening here only needs to reveal the card.
  const handleStartAddingBottom = useCallback(() => setIsAddingBottom(true), []);

  const handleCloseBlankCard = useCallback(() => setIsAddingBottom(false), []);

  const handleStartAddingTop = useCallback(() => setIsAddingTop(true), []);

  const handleCloseTopBlankCard = useCallback(() => setIsAddingTop(false), []);

  const content = (
    <div
      ref={setNodeRef}
      className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1 transition-colors ${
        isOver
          ? 'bg-[var(--color-surface-2)]/40 ring-1 ring-inset ring-[var(--color-accent)]/30'
          : ''
      }`}
    >
      {isAddingTop ? (
        <BlankMissionCard
          inputId={topInputId}
          statusId={status.id}
          position="top"
          projectId={projectId}
          onCreateMission={onCreateMission}
          onCreateAndOpenMission={onCreateAndOpenMission}
          onClose={handleCloseTopBlankCard}
          onSubmitted={() => setTopFocusEditorCount(c => c + 1)}
          focusTrigger={topFocusEditorCount}
        />
      ) : null}
      {missions.map(mission => {
        const assignee = resolveAssignee(mission, membersByWorkspaceUserId);
        const selected = mission.id === selectedMissionId;
        const cardProps = {
          mission,
          projectId,
          projectName,
          projectColor,
          assignee,
          selected
        };

        return draggable ? (
          <SortableMissionCard key={mission.id} {...cardProps} />
        ) : (
          <MissionCard key={mission.id} {...cardProps} />
        );
      })}
      {isAddingBottom ? (
        <BlankMissionCard
          inputId={inputId}
          statusId={status.id}
          position="bottom"
          projectId={projectId}
          onCreateMission={onCreateMission}
          onCreateAndOpenMission={onCreateAndOpenMission}
          onClose={handleCloseBlankCard}
          onSubmitted={() => setFocusEditorCount(c => c + 1)}
          focusTrigger={focusEditorCount}
        />
      ) : (
        <button
          type="button"
          onClick={handleStartAddingBottom}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-muted-foreground/20 py-2 text-xs text-muted-foreground/40 transition-colors hover:border-muted-foreground/40 hover:text-muted-foreground/70"
        >
          <Plus className="h-3 w-3" />
          Add mission
        </button>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 w-72 shrink-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between px-1">
        <Badge className={statusClasses(status.type)}>
          {status.name}
          <StatusIcon className="ml-1.5 h-3 w-3 opacity-60" />
        </Badge>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--color-ink-dim)]">{count}</span>
          <button
            type="button"
            onClick={handleStartAddingTop}
            aria-label="Add mission to top of column"
            className="rounded-md p-0.5 text-muted-foreground/40 transition-colors hover:bg-[var(--color-surface-2)]/60 hover:text-muted-foreground/80"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {draggable ? (
        <SortableContext items={missions.map(t => t.id)} strategy={verticalListSortingStrategy}>
          {content}
        </SortableContext>
      ) : (
        content
      )}
    </div>
  );
}
