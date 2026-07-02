import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useMatch, useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  MyMissionDto,
  WorkspaceMemberDto,
  WorkspaceStatusDto
} from '../../shared/contract.ts';
import { Button, EmptyState, Spinner } from '../components/ui.tsx';
import { ApiRequestError } from '../lib/api.ts';
import { readLastUsedProjectId, writeLastUsedProjectId } from '../lib/last-used-project.ts';
import {
  useCreateMission,
  useMeta,
  useProjects,
  useSetMissionStatus,
  useWorkspaceMembers,
  useWorkspaceMyMissions,
  useWorkspaceStatuses
} from '../lib/queries.ts';

import type { BlankMissionCreateOptions } from './BlankMissionCard.tsx';
import {
  type BoardView,
  type ColumnMap,
  getMissionTags,
  resolveColumnMissions
} from './board-shared.ts';
import type { BoardColumnStatus } from './BoardColumn.tsx';
import { MissionListView } from './MissionListView.tsx';
import { MissionStatusFilterDropdown } from './MissionStatusFilterDropdown.tsx';
import { MissionsViewToggle } from './MissionsViewToggle.tsx';
import { MissionTagFilterDropdown } from './MissionTagFilterDropdown.tsx';
import { MyMissionsColumn } from './MyMissionsColumn.tsx';
import { SortableMissionCard } from './SortableMissionCard.tsx';
import { useMyMissionsDnd } from './useMyMissionsDnd.ts';

const UNCATEGORIZED_ID = '__my_missions_uncategorized__';
const VIEW_STORAGE_KEY = 'overlord:my-missions-view';

function readStoredView(): BoardView {
  if (typeof window === 'undefined') return 'board';
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function storeView(view: BoardView) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Ignore private-mode/quota failures; the toggle still works in memory.
  }
}

function describeReorderError(
  status: WorkspaceStatusDto,
  error: unknown,
  workspaceName: string
): string {
  if (error instanceof ApiRequestError && error.code === 'STATUS_UNAVAILABLE_FOR_WORKSPACE') {
    return `“${status.name}” is not available for missions in the ${workspaceName} workspace.`;
  }
  return error instanceof Error ? error.message : 'Could not move the mission.';
}

export function MyMissionsPage() {
  const navigate = useNavigate();
  const meta = useMeta();
  const statusesQ = useWorkspaceStatuses();
  const myMissionsQ = useWorkspaceMyMissions();
  const projectsQ = useProjects();
  const createMission = useCreateMission();
  const setMissionStatus = useSetMissionStatus();

  const missionMatch = useMatch({ from: '/workspace/missions/$missionId', shouldThrow: false });
  const selectedMissionId = missionMatch?.params.missionId;

  const workspaceId = meta.data?.workspace?.id ?? null;
  const workspaceName = meta.data?.workspace?.name ?? 'this';
  const membersQ = useWorkspaceMembers(workspaceId);

  const [view, setView] = useState<BoardView>(() => readStoredView());
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedStatusIds, setSelectedStatusIds] = useState<string[]>([]);
  const [alert, setAlert] = useState<string | null>(null);

  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);
  const missions = useMemo(() => myMissionsQ.data?.missions ?? [], [myMissionsQ.data]);
  const projects = useMemo(() => projectsQ.data ?? [], [projectsQ.data]);

  const membersByWorkspaceUserId = useMemo(() => {
    const map = new Map<string, WorkspaceMemberDto>();
    for (const member of membersQ.data ?? []) map.set(member.workspaceUserId, member);
    return map;
  }, [membersQ.data]);

  const missionById = useMemo(() => {
    const map = new Map<string, MyMissionDto>();
    for (const t of missions) map.set(t.id, t);
    return map;
  }, [missions]);

  const tagOptions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; color: string | null }>();
    for (const mission of missions) {
      for (const tag of getMissionTags(mission)) {
        if (!byId.has(tag.id)) byId.set(tag.id, tag);
      }
    }
    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [missions]);

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

  const clearFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedStatusIds([]);
  }, []);

  // Server returns merge order (positioned first, then fallback); preserve it per
  // column. Any mission whose status is no longer an active workspace column falls
  // into the Uncategorized bucket.
  const { baseColumns, uncategorized } = useMemo(() => {
    const statusIds = new Set(statuses.map(s => s.id));
    const cols: ColumnMap = {};
    for (const s of statuses) cols[s.id] = [];
    const unmatched: string[] = [];
    for (const t of missions) {
      if (statusIds.has(t.statusId)) (cols[t.statusId] ??= []).push(t.id);
      else unmatched.push(t.id);
    }
    return { baseColumns: cols, uncategorized: unmatched };
  }, [statuses, missions]);

  const defaultCreateProjectId = useMemo(() => {
    const lastUsedProjectId = readLastUsedProjectId();
    if (lastUsedProjectId && projects.some(project => project.id === lastUsedProjectId)) {
      return lastUsedProjectId;
    }
    return projects[0]?.id ?? missions[0]?.projectId ?? '';
  }, [missions, projects]);

  const columnsForDnd = useMemo<ColumnMap>(() => {
    const cols: ColumnMap = { ...baseColumns };
    if (uncategorized.length > 0) cols[UNCATEGORIZED_ID] = uncategorized;
    return cols;
  }, [baseColumns, uncategorized]);

  const filteredColumns = useMemo<ColumnMap>(() => {
    const visibleMissionIds = new Set(filteredMissions.map(mission => mission.id));
    const map: ColumnMap = {};
    for (const status of statuses) {
      map[status.id] = (baseColumns[status.id] ?? []).filter(id => visibleMissionIds.has(id));
    }
    const filteredUncategorized = uncategorized.filter(id => visibleMissionIds.has(id));
    if (filteredUncategorized.length > 0) {
      map[UNCATEGORIZED_ID] = filteredUncategorized;
    }
    return map;
  }, [baseColumns, filteredMissions, statuses, uncategorized]);

  const onReorderError = useCallback(
    (status: WorkspaceStatusDto, error: unknown) => {
      setAlert(describeReorderError(status, error, workspaceName));
    },
    [workspaceName]
  );

  const myMissionsDnd = useMyMissionsDnd({
    columns: columnsForDnd,
    statuses,
    onReorderError
  });
  const { activeId, displayColumns, dndContextProps } = myMissionsDnd;
  const visibleColumns = isFilterActive ? filteredColumns : displayColumns;

  const listDnd = useMyMissionsDnd({
    columns: visibleColumns,
    statuses: visibleStatuses,
    onReorderError,
    draggable: !isFilterActive
  });

  // The list view groups by the same workspace statuses as the board, plus the
  // Uncategorized bucket when any mission's status isn't an active column.
  const listStatuses = useMemo<BoardColumnStatus[]>(() => {
    const items: BoardColumnStatus[] = [...visibleStatuses];
    if (!isStatusFilterActive && (visibleColumns[UNCATEGORIZED_ID] ?? []).length > 0) {
      items.push({ id: UNCATEGORIZED_ID, name: 'Uncategorized', type: null });
    }
    return items;
  }, [isStatusFilterActive, visibleColumns, visibleStatuses]);

  const handleViewChange = (next: BoardView) => {
    setView(next);
    storeView(next);
  };

  const openMission = useCallback(
    (missionId: string) => {
      void navigate({ to: '/workspace/missions/$missionId', params: { missionId } });
    },
    [navigate]
  );

  // The list-row checkbox marks a mission complete by moving it into the
  // workspace status whose type is `complete`, mirroring the project board.
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

  const getMissionCardContext = useCallback(
    (mission: MyMissionDto) => ({
      projectId: mission.projectId,
      projectName: mission.projectName,
      projectColor: mission.projectColor,
      onOpen: () => openMission(mission.id)
    }),
    [openMission]
  );

  const createMissionInColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      options?: BlankMissionCreateOptions
    ): Promise<{ missionId: string }> => {
      const targetProjectId = options?.projectId ?? defaultCreateProjectId;
      if (!targetProjectId) throw new Error('Choose a project before creating a mission.');

      const tagIds = options?.tagIds ?? [];
      const detail = await createMission.mutateAsync({
        projectId: targetProjectId,
        firstObjective: objective,
        ...(statusId ? { statusId } : {}),
        ...(tagIds.length > 0 ? { tagIds } : {})
      });
      writeLastUsedProjectId(targetProjectId);
      return { missionId: detail.id };
    },
    [createMission, defaultCreateProjectId]
  );

  const handleCreateMissionFromColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      _position: 'top' | 'bottom',
      options?: BlankMissionCreateOptions
    ) => {
      await createMissionInColumn(statusId, objective, options);
    },
    [createMissionInColumn]
  );

  const handleCreateAndOpenMissionFromColumn = useCallback(
    async (
      statusId: string,
      objective: string,
      _position: 'top' | 'bottom',
      options?: BlankMissionCreateOptions
    ) => {
      const { missionId } = await createMissionInColumn(statusId, objective, options);
      void navigate({ to: '/workspace/missions/$missionId', params: { missionId } });
    },
    [createMissionInColumn, navigate]
  );

  // Drop a stale alert once the underlying data refetches.
  useEffect(() => {
    if (!alert) return;
    const timer = window.setTimeout(() => setAlert(null), 6000);
    return () => window.clearTimeout(timer);
  }, [alert]);

  if (statusesQ.isLoading || myMissionsQ.isLoading || projectsQ.isLoading) {
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  }
  if (myMissionsQ.isError) {
    return (
      <div className="p-8 text-sm text-red-400">
        Could not load your missions: {(myMissionsQ.error as Error).message}
      </div>
    );
  }

  const activeMission = activeId ? missionById.get(activeId) : undefined;

  const renderColumns = (draggable: boolean) => (
    <>
      {visibleStatuses.map(status => {
        const colMissions = resolveColumnMissions(visibleColumns[status.id] ?? [], missionById);
        return (
          <MyMissionsColumn
            key={status.id}
            droppableId={status.id}
            title={status.name}
            type={status.type}
            missions={colMissions}
            count={colMissions.length}
            defaultProjectId={defaultCreateProjectId}
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedMissionId={selectedMissionId}
            draggable={draggable}
            onOpenMission={openMission}
            onCreateMission={handleCreateMissionFromColumn}
            onCreateAndOpenMission={handleCreateAndOpenMissionFromColumn}
          />
        );
      })}
      {!isStatusFilterActive && (visibleColumns[UNCATEGORIZED_ID] ?? []).length > 0 ? (
        <MyMissionsColumn
          droppableId={UNCATEGORIZED_ID}
          title="Uncategorized"
          type={null}
          missions={resolveColumnMissions(visibleColumns[UNCATEGORIZED_ID] ?? [], missionById)}
          count={(visibleColumns[UNCATEGORIZED_ID] ?? []).length}
          defaultProjectId={defaultCreateProjectId}
          membersByWorkspaceUserId={membersByWorkspaceUserId}
          selectedMissionId={selectedMissionId}
          draggable={draggable}
          onOpenMission={openMission}
          onCreateMission={handleCreateMissionFromColumn}
          onCreateAndOpenMission={handleCreateAndOpenMissionFromColumn}
        />
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 min-w-0">
        <div className="border-b border-(--color-border) px-5 py-3">
          <h1 className="text-sm font-semibold">My Missions</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-(--color-border) px-5 mt-5">
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
        {alert ? (
          <div className="flex items-start justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-sm text-amber-700 dark:text-amber-300">
            <span>{alert}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
              onClick={() => setAlert(null)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto pt-3 px-5">
        {missions.length === 0 ? (
          <EmptyState
            title="No missions are assigned to you"
            hint="Missions assigned to you across this workspace's projects show up here, grouped by status."
          />
        ) : filteredMissions.length === 0 ? (
          <EmptyState
            title="No missions match these filters"
            hint="Clear the active filters to show every mission assigned to you."
            action={
              <Button variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : view === 'board' && isFilterActive ? (
          <div className="flex h-full min-h-0 items-stretch gap-2">{renderColumns(false)}</div>
        ) : view === 'board' ? (
          <DndContext {...dndContextProps}>
            <div className="flex h-full min-h-0 items-stretch gap-2">{renderColumns(true)}</div>
            <DragOverlay>
              {activeMission ? (
                <SortableMissionCard
                  mission={activeMission}
                  projectId={activeMission.projectId}
                  projectName={activeMission.projectName}
                  projectColor={activeMission.projectColor}
                  assignee={
                    activeMission.assignedWorkspaceUserId
                      ? membersByWorkspaceUserId.get(activeMission.assignedWorkspaceUserId)
                      : undefined
                  }
                  selected={activeMission.id === selectedMissionId}
                  isDragOverlay
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <MissionListView
            statuses={listStatuses}
            dnd={listDnd}
            missionById={missionById}
            projectId={defaultCreateProjectId}
            projectName=""
            projectColor={null}
            createProjectId={defaultCreateProjectId}
            createStatusScope="workspace"
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedMissionId={selectedMissionId}
            getMissionCardContext={getMissionCardContext}
            onCreateMission={handleCreateMissionFromColumn}
            onCreateAndOpenMission={handleCreateAndOpenMissionFromColumn}
            onCompleteMission={completeStatusId ? handleCompleteMission : undefined}
          />
        )}
      </div>
    </div>
  );
}
