import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';

import { type StatusStyle } from '@/components/ui.tsx';
import { cn } from '@/lib/utils';

import type { MissionDto, WorkspaceMemberDto } from '../../shared/contract.ts';

import { BlankMissionCard, type BlankMissionCreateOptions } from './BlankMissionCard.tsx';
import { resolveAssignee } from './board-shared.ts';
import type { BoardColumnStatus, MissionCardContext } from './BoardColumn.tsx';
import { MissionListCard } from './MissionListCard.tsx';

export function MissionListStatusGroup<TMission extends MissionDto = MissionDto>({
  status,
  style,
  missions,
  projectId,
  projectName,
  projectColor,
  createProjectId = projectId,
  createStatusScope = 'project',
  membersByWorkspaceUserId,
  selectedMissionId,
  isCollapsed,
  onToggleCollapse,
  getMissionCardContext,
  onCreateMission,
  onCreateAndOpenMission,
  onCompleteMission
}: {
  status: BoardColumnStatus;
  style: StatusStyle;
  missions: TMission[];
  projectId: string;
  projectName: string;
  projectColor: string | null;
  createProjectId?: string;
  createStatusScope?: 'project' | 'workspace';
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedMissionId?: string;
  isCollapsed: boolean;
  onToggleCollapse: (statusId: string) => void;
  getMissionCardContext?: (mission: TMission) => MissionCardContext;
  onCompleteMission?: (missionId: string) => void;
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
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status.id });
  const Icon = style.icon;
  const [isAdding, setIsAdding] = useState(false);
  const [focusEditorCount, setFocusEditorCount] = useState(0);
  const inputId = `mission-list-input-${status.id}`;

  const handleStartAdding = useCallback(() => {
    if (isCollapsed) onToggleCollapse(status.id);
    setIsAdding(true);
  }, [isCollapsed, onToggleCollapse, status.id]);

  const handleCloseBlankCard = useCallback(() => setIsAdding(false), []);

  const canAdd = Boolean(onCreateMission && status.type && createProjectId);

  return (
    <section className={cn(' transition-colors', isOver && 'ring-1 ring-inset ring-primary/30')}>
      <div className="group/header flex items-center gap-2 px-1.5 py-1.5">
        <span
          className={cn(
            'flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded',
            style.bg,
            style.text
          )}
        >
          <Icon className="h-3 w-3" />
        </span>
        <button
          type="button"
          aria-label={isCollapsed ? `Expand ${status.name}` : `Collapse ${status.name}`}
          aria-expanded={!isCollapsed}
          onClick={() => onToggleCollapse(status.id)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => onToggleCollapse(status.id)}
          className={cn('shrink-0 text-[10px] font-semibold uppercase tracking-wider', style.text)}
        >
          {status.name}
        </button>

        {/* Status-tinted divider line filling the row, matching the reference list view. */}
        <span className={cn('h-px flex-1 rounded-full', style.rule)} aria-hidden="true" />

        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {missions.length}
        </span>
        {canAdd ? (
          <button
            type="button"
            onClick={handleStartAdding}
            aria-label={`Add mission to ${status.name}`}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {isCollapsed ? null : (
        <div
          ref={setNodeRef}
          className={cn(
            'ml-3 flex min-h-10 flex-col gap-0.5 border-l pl-1.5 pb-1',
            style.rail,
            isOver && 'bg-muted/30'
          )}
        >
          {canAdd && isAdding && onCreateMission ? (
            <BlankMissionCard
              inputId={inputId}
              statusId={status.id}
              position="top"
              projectId={createProjectId}
              statusScope={createStatusScope}
              onCreateMission={onCreateMission}
              onCreateAndOpenMission={onCreateAndOpenMission}
              onClose={handleCloseBlankCard}
              onSubmitted={() => setFocusEditorCount(c => c + 1)}
              focusTrigger={focusEditorCount}
            />
          ) : null}
          <SortableContext items={missions.map(t => t.id)} strategy={verticalListSortingStrategy}>
            {missions.length === 0 ? (
              isAdding ? null : (
                <button
                  type="button"
                  onClick={canAdd ? handleStartAdding : undefined}
                  disabled={!canAdd}
                  className={cn(
                    'rounded-md border border-dashed border-muted-foreground/20 px-2 py-4 text-center text-xs text-muted-foreground/50 transition-colors',
                    canAdd && 'hover:border-muted-foreground/40 hover:text-muted-foreground/70'
                  )}
                >
                  {canAdd
                    ? 'No missions — drag one here or click + to add'
                    : 'No missions in this status.'}
                </button>
              )
            ) : (
              missions.map(mission => {
                const cardContext = getMissionCardContext?.(mission) ?? {
                  projectId,
                  projectName,
                  projectColor
                };
                return (
                  <MissionListCard
                    key={mission.id}
                    mission={mission}
                    projectId={cardContext.projectId}
                    projectName={cardContext.projectName}
                    projectColor={cardContext.projectColor}
                    assignee={resolveAssignee(mission, membersByWorkspaceUserId)}
                    selected={mission.id === selectedMissionId}
                    onComplete={onCompleteMission}
                    onOpen={cardContext.onOpen}
                  />
                );
              })
            )}
          </SortableContext>
        </div>
      )}
    </section>
  );
}
