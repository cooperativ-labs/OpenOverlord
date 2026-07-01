import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useMatch, useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { NewMissionModal } from '@/components/NewMissionModal.tsx';

import type { MissionDto, WorkspaceMemberDto } from '../../shared/contract.ts';
import { ProjectSettingsSection } from '../components/projects/ProjectSettingsSection.tsx';
import { Button, EmptyState, Spinner } from '../components/ui.tsx';
import {
  useCreateMission,
  useMissions,
  useProject,
  useProjectTags,
  useReorderBoardColumn,
  useSetMissionStatus,
  useWorkspaceMembers,
  useWorkspaceStatuses
} from '../lib/queries.ts';

import type { BlankMissionCreateOptions } from './BlankMissionCard.tsx';
import {
  type BoardView,
  type ColumnMap,
  getMissionTags,
  readStoredBoardView,
  resolveAssignee,
  resolveColumnMissions,
  storeBoardView
} from './board-shared.ts';
import { BoardColumn } from './BoardColumn.tsx';
import { MissionListView } from './MissionListView.tsx';
import { MissionStatusFilterDropdown } from './MissionStatusFilterDropdown.tsx';
import { MissionsViewToggle } from './MissionsViewToggle.tsx';
import { MissionTagFilterDropdown } from './MissionTagFilterDropdown.tsx';
import { SortableMissionCard } from './SortableMissionCard.tsx';
import { useBoardColumnDnd } from './useBoardColumnDnd.ts';

export function BoardPage() {
  const navigate = useNavigate();
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const missionMatch = useMatch({
    from: '/projects/$projectId/missions/$missionId',
    shouldThrow: false
  });
  const selectedMissionId = missionMatch?.params.missionId;
  const project = useProject(projectId);
  const statusesQ = useWorkspaceStatuses();
  const missionsQ = useMissions(projectId);
  const projectTagsQ = useProjectTags(projectId);
  const createMission = useCreateMission();
  const reorder = useReorderBoardColumn();
  const setMissionStatus = useSetMissionStatus();
  const [modalOpen, setModalOpen] = useState(false);
  const [view, setView] = useState<BoardView>(() => readStoredBoardView(projectId));
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedStatusIds, setSelectedStatusIds] = useState<string[]>([]);

  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);
  const missions = useMemo(() => missionsQ.data ?? [], [missionsQ.data]);
  const workspaceId = project.data?.workspaceId ?? null;
  const membersQ = useWorkspaceMembers(workspaceId);

  const membersByWorkspaceUserId = useMemo(() => {
    const map = new Map<string, WorkspaceMemberDto>();
    for (const member of membersQ.data ?? []) {
      map.set(member.workspaceUserId, member);
    }
    return map;
  }, [membersQ.data]);

  const projectName = project.data?.name ?? '';
  const projectColor = project.data?.color ?? null;

  useEffect(() => {
    setView(readStoredBoardView(projectId));
    setSelectedTagIds([]);
    setSelectedStatusIds([]);
  }, [projectId]);

  const handleViewChange = (nextView: BoardView) => {
    setView(nextView);
    storeBoardView(projectId, nextView);
  };

  const missionById = useMemo(() => {
    const map = new Map<string, MissionDto>();
    for (const t of missions) map.set(t.id, t);
    return map;
  }, [missions]);

  const tagOptions = useMemo(
    () =>
      (projectTagsQ.data ?? [])
        .filter(tag => tag.active)
        .map(tag => ({
          id: tag.id,
          label: tag.label,
          color: tag.color
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [projectTagsQ.data]
  );

  useEffect(() => {
    if (selectedTagIds.length === 0) return;
    const validIds = new Set(tagOptions.map(tag => tag.id));
    const next = selectedTagIds.filter(id => validIds.has(id));
    if (next.length !== selectedTagIds.length) setSelectedTagIds(next);
  }, [selectedTagIds, tagOptions]);

  useEffect(() => {
    if (selectedStatusIds.length === 0) return;
    const validIds = new Set(statuses.map(status => status.id));
    const next = selectedStatusIds.filter(id => validIds.has(id));
    if (next.length !== selectedStatusIds.length) setSelectedStatusIds(next);
  }, [selectedStatusIds, statuses]);

  const selectedTagIdSet = useMemo(() => new Set(selectedTagIds), [selectedTagIds]);
  const selectedStatusIdSet = useMemo(() => new Set(selectedStatusIds), [selectedStatusIds]);
  const filteredMissions = useMemo(() => {
    let result = missions;
    if (selectedStatusIds.length > 0) {
      result = result.filter(mission => selectedStatusIdSet.has(mission.statusId));
    }
    if (selectedTagIds.length > 0) {
      result = result.filter(mission =>
        getMissionTags(mission).some(tag => selectedTagIdSet.has(tag.id))
      );
    }
    return result;
  }, [
    selectedStatusIdSet,
    selectedStatusIds.length,
    selectedTagIdSet,
    selectedTagIds.length,
    missions
  ]);

  const baseColumns = useMemo<ColumnMap>(() => {
    const map: ColumnMap = {};
    for (const s of statuses) map[s.id] = [];
    for (const t of missions) (map[t.statusId] ??= []).push(t.id);
    return map;
  }, [statuses, missions]);

  const filteredColumns = useMemo<ColumnMap>(() => {
    const visibleMissionIds = new Set(filteredMissions.map(mission => mission.id));
    const map: ColumnMap = {};
    for (const s of statuses) {
      map[s.id] = (baseColumns[s.id] ?? []).filter(id => visibleMissionIds.has(id));
    }
    return map;
  }, [baseColumns, filteredMissions, statuses]);

  const { activeId, displayColumns, dndContextProps } = useBoardColumnDnd({
    columns: baseColumns,
    statuses,
    projectId
  });

  const placeCreatedMission = useCallback(
    async ({
      statusId,
      position,
      missionId
    }: {
      statusId: string;
      position: 'top' | 'bottom';
      missionId: string;
    }) => {
      const status = statuses.find(s => s.id === statusId);
      if (!status) return;

      const existingIds = missions
        .filter(mission => mission.statusId === statusId)
        .sort((a, b) => a.boardPosition - b.boardPosition)
        .map(mission => mission.id);

      const orderedMissionIds =
        position === 'top' ? [missionId, ...existingIds] : [...existingIds, missionId];

      await reorder.mutateAsync({
        projectId,
        statusId,
        statusType: status.type,
        orderedMissionIds
      });
    },
    [projectId, reorder, statuses, missions]
  );

  // Shared creation path for the two column callbacks below: create the mission,
  // then reposition it within this board column when it actually landed here
  // (a different project/status means it lives on another board).
  const createMissionInColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      position: 'top' | 'bottom',
      options?: BlankMissionCreateOptions
    ): Promise<{ missionId: string; targetProjectId: string }> => {
      const targetProjectId = options?.projectId ?? projectId;
      const tagIds = options?.tagIds ?? [];
      const detail = await createMission.mutateAsync({
        projectId: targetProjectId,
        firstObjective: objective,
        ...(statusId ? { statusId } : {}),
        ...(tagIds.length > 0 ? { tagIds } : {})
      });
      if (statusId && targetProjectId === projectId) {
        await placeCreatedMission({ statusId, position, missionId: detail.id });
      }
      return { missionId: detail.id, targetProjectId };
    },
    [createMission, placeCreatedMission, projectId]
  );

  const handleCreateMissionFromColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      position: 'top' | 'bottom',
      options?: BlankMissionCreateOptions
    ) => {
      await createMissionInColumn(statusId, objective, position, options);
    },
    [createMissionInColumn]
  );

  const handleCreateAndOpenMissionFromColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      position: 'top' | 'bottom',
      options?: BlankMissionCreateOptions
    ) => {
      const { missionId, targetProjectId } = await createMissionInColumn(
        statusId,
        objective,
        position,
        options
      );
      navigate({
        to: '/projects/$projectId/missions/$missionId',
        params: { projectId: targetProjectId, missionId }
      });
    },
    [createMissionInColumn, navigate]
  );

  // The list-row checkbox marks a mission complete by moving it into the
  // workspace status whose type is `complete`. No-op if no such status exists.
  const completeStatusId = useMemo(
    () => statuses.find(status => status.type === 'complete')?.id ?? null,
    [statuses]
  );

  const handleCompleteMission = useCallback(
    (missionId: string) => {
      if (!completeStatusId) return;
      void setMissionStatus.mutateAsync({ missionId, statusId: completeStatusId });
    },
    [completeStatusId, setMissionStatus]
  );

  const isTagFilterActive = selectedTagIds.length > 0;
  const isStatusFilterActive = selectedStatusIds.length > 0;
  const isFilterActive = isTagFilterActive || isStatusFilterActive;
  const visibleStatuses = useMemo(
    () =>
      isStatusFilterActive
        ? statuses.filter(status => selectedStatusIdSet.has(status.id))
        : statuses,
    [isStatusFilterActive, selectedStatusIdSet, statuses]
  );
  const visibleColumns = isFilterActive ? filteredColumns : displayColumns;

  const clearFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedStatusIds([]);
  }, []);

  if (project.isLoading || statusesQ.isLoading || missionsQ.isLoading) {
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  }
  if (project.isError) {
    return (
      <div className="p-8 text-sm text-red-400">
        Could not load project: {(project.error as Error).message}
      </div>
    );
  }

  const activeMission = activeId ? missionById.get(activeId) : undefined;
  const activeAssignee = activeMission
    ? resolveAssignee(activeMission, membersByWorkspaceUserId)
    : undefined;

  const columnProps = {
    projectId,
    projectName,
    projectColor,
    membersByWorkspaceUserId,
    selectedMissionId,
    onCreateMission: handleCreateMissionFromColumn,
    onCreateAndOpenMission: handleCreateAndOpenMissionFromColumn
  };

  const renderBoardColumns = (columnsDraggable: boolean) =>
    visibleStatuses.map(status => {
      const colMissions = resolveColumnMissions(visibleColumns[status.id] ?? [], missionById);
      return (
        <BoardColumn
          key={status.id}
          status={status}
          missions={colMissions}
          count={colMissions.length}
          draggable={columnsDraggable}
          {...columnProps}
        />
      );
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 min-w-0">
        <ProjectSettingsSection
          projectId={projectId}
          initialName={projectName}
          initialColor={projectColor}
        />
        <div className="flex flex-wrap items-center gap-2  border-(--color-border) px-5 mt-5">
          <div className="flex flex-wrap items-center gap-2">
            <MissionsViewToggle value={view} onChange={handleViewChange} />
            <MissionStatusFilterDropdown
              statuses={statuses}
              selectedStatusIds={selectedStatusIds}
              onClear={() => setSelectedStatusIds([])}
              onToggle={statusId =>
                setSelectedStatusIds(current =>
                  current.includes(statusId)
                    ? current.filter(id => id !== statusId)
                    : [...current, statusId]
                )
              }
            />
            <MissionTagFilterDropdown
              tagOptions={tagOptions}
              selectedTagIds={selectedTagIds}
              onClear={() => setSelectedTagIds([])}
              onToggle={tagId =>
                setSelectedTagIds(current =>
                  current.includes(tagId) ? current.filter(id => id !== tagId) : [...current, tagId]
                )
              }
            />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3 px-5">
        {missions.length === 0 ? (
          <EmptyState
            title="No missions in this project"
            hint="Create a mission to track a unit of work. Each mission holds an ordered list of objectives."
            action={
              <Button variant="primary" onClick={() => setModalOpen(true)}>
                + New mission
              </Button>
            }
          />
        ) : filteredMissions.length === 0 ? (
          <EmptyState
            title="No missions match these filters"
            hint="Clear the active filters to show every mission in this project."
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : view === 'board' && isFilterActive ? (
          <div className="flex h-full min-h-0 items-stretch gap-2">{renderBoardColumns(false)}</div>
        ) : view === 'board' ? (
          <DndContext {...dndContextProps}>
            <div className="flex h-full min-h-0 items-stretch gap-4">2
              {renderBoardColumns(true)}
            </div>
            <DragOverlay>
              {activeMission ? (
                <SortableMissionCard
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
        ) : (
          <MissionListView
            statuses={visibleStatuses}
            columns={visibleColumns}
            missionById={missionById}
            projectId={projectId}
            projectName={projectName}
            projectColor={projectColor}
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedMissionId={selectedMissionId}
            draggable={!isFilterActive}
            onCreateMission={handleCreateMissionFromColumn}
            onCreateAndOpenMission={handleCreateAndOpenMissionFromColumn}
            onCompleteMission={completeStatusId ? handleCompleteMission : undefined}
          />
        )}
      </div>

      <NewMissionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        defaultProjectId={projectId}
      />
    </div>
  );
}
