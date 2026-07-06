import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useQueries } from '@tanstack/react-query';
import { useMatch, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  MyMissionDto,
  WorkspaceMemberDto,
  WorkspaceStatusDto
} from '../../shared/contract.ts';
import { Button, EmptyState, Spinner } from '../components/ui.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../components/ui/dialog.tsx';
import { api } from '../lib/api.ts';
import { readLastUsedProjectId, writeLastUsedProjectId } from '../lib/last-used-project.ts';
import {
  keys,
  useCreateMission,
  useMeta,
  useProjects,
  useReorderMyMissions,
  useSetMissionStatus,
  useWorkspaceMyMissions
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
import { MissionWorkspaceFilterDropdown } from './MissionWorkspaceFilterDropdown.tsx';
import {
  buildMergedStatusColumns,
  groupMissionsByMergedColumn,
  resolveMergedColumnReorder
} from './my-missions-columns.ts';
import { MyMissionsColumn } from './MyMissionsColumn.tsx';
import { SortableMissionCard } from './SortableMissionCard.tsx';
import { type MyMissionsDropTarget, useMyMissionsDnd } from './useMyMissionsDnd.ts';

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

export function MyMissionsPage() {
  const navigate = useNavigate();
  const meta = useMeta();
  const myMissionsQ = useWorkspaceMyMissions();
  const projectsQ = useProjects();
  const createMission = useCreateMission();
  const setMissionStatus = useSetMissionStatus();
  const reorder = useReorderMyMissions();

  const missionMatch = useMatch({ from: '/workspace/missions/$missionId', shouldThrow: false });
  const selectedMissionId = missionMatch?.params.missionId;

  const workspaces = useMemo(() => meta.data?.workspaces ?? [], [meta.data]);
  const workspaceIds = useMemo(() => workspaces.map(workspace => workspace.id), [workspaces]);
  const activeWorkspaceId = meta.data?.workspace?.id ?? null;

  // My Missions aggregates across every workspace of the active organization, so
  // statuses and members are fetched per workspace and merged. These share query
  // keys with the single-workspace hooks, so the realtime feed invalidates both.
  const statusQueries = useQueries({
    queries: workspaceIds.map(id => ({
      queryKey: keys.workspaceStatuses(id),
      queryFn: () => api.listWorkspaceStatusesForWorkspace(id),
      enabled: Boolean(id)
    }))
  });
  const memberQueries = useQueries({
    queries: workspaceIds.map(id => ({
      queryKey: keys.workspaceMembers(id),
      queryFn: () => api.listWorkspaceMembers(id),
      enabled: Boolean(id)
    }))
  });

  const [view, setView] = useState<BoardView>(() => readStoredView());
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedStatusKeys, setSelectedStatusKeys] = useState<string[]>([]);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([]);
  const [dropError, setDropError] = useState<{ statusName: string; workspaceName: string } | null>(
    null
  );

  const missions = useMemo(() => myMissionsQ.data?.missions ?? [], [myMissionsQ.data]);
  const projects = useMemo(() => projectsQ.data ?? [], [projectsQ.data]);

  const statusesByWorkspace = useMemo(() => {
    const map = new Map<string, WorkspaceStatusDto[]>();
    workspaceIds.forEach((id, index) => {
      const data = statusQueries[index]?.data;
      if (data) map.set(id, data);
    });
    return map;
  }, [workspaceIds, statusQueries]);

  // The active workspace drives column ordering and casing (first-seen wins).
  const orderedWorkspaceIds = useMemo(() => {
    if (!activeWorkspaceId || !workspaceIds.includes(activeWorkspaceId)) return workspaceIds;
    return [activeWorkspaceId, ...workspaceIds.filter(id => id !== activeWorkspaceId)];
  }, [workspaceIds, activeWorkspaceId]);

  const merged = useMemo(
    () => buildMergedStatusColumns(orderedWorkspaceIds, statusesByWorkspace),
    [orderedWorkspaceIds, statusesByWorkspace]
  );

  const membersByWorkspaceUserId = useMemo(() => {
    const map = new Map<string, WorkspaceMemberDto>();
    for (const query of memberQueries) {
      for (const member of query.data ?? []) map.set(member.workspaceUserId, member);
    }
    return map;
  }, [memberQueries]);

  const workspaceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const workspace of workspaces) map.set(workspace.id, workspace.name);
    return map;
  }, [workspaces]);

  const missionById = useMemo(() => {
    const map = new Map<string, MyMissionDto>();
    for (const t of missions) map.set(t.id, t);
    return map;
  }, [missions]);

  // Only workspaces the caller actually has missions in are worth filtering by.
  // Derived from the unfiltered set so the option list is stable as filters change.
  const workspaceFilterOptions = useMemo(() => {
    const represented = new Set(missions.map(mission => mission.workspaceId));
    return workspaces
      .filter(workspace => represented.has(workspace.id))
      .map(workspace => ({ id: workspace.id, name: workspace.name }));
  }, [missions, workspaces]);

  const statusFilterOptions = useMemo(
    () => merged.columns.map(column => ({ id: column.key, name: column.name, type: column.type })),
    [merged.columns]
  );

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
    if (selectedStatusKeys.length === 0) return;
    const validKeys = new Set(merged.columns.map(column => column.key));
    const next = selectedStatusKeys.filter(key => validKeys.has(key));
    if (next.length !== selectedStatusKeys.length) setSelectedStatusKeys(next);
  }, [selectedStatusKeys, merged.columns]);

  useEffect(() => {
    if (selectedWorkspaceIds.length === 0) return;
    const validIds = new Set(workspaceFilterOptions.map(workspace => workspace.id));
    const next = selectedWorkspaceIds.filter(id => validIds.has(id));
    if (next.length !== selectedWorkspaceIds.length) setSelectedWorkspaceIds(next);
  }, [selectedWorkspaceIds, workspaceFilterOptions]);

  const selectedTagIdSet = useMemo(() => new Set(selectedTagIds), [selectedTagIds]);
  const selectedStatusKeySet = useMemo(() => new Set(selectedStatusKeys), [selectedStatusKeys]);
  const selectedWorkspaceIdSet = useMemo(
    () => new Set(selectedWorkspaceIds),
    [selectedWorkspaceIds]
  );

  const filteredMissions = useMemo(() => {
    let result = missions;
    if (selectedWorkspaceIds.length > 0) {
      result = result.filter(mission => selectedWorkspaceIdSet.has(mission.workspaceId));
    }
    if (selectedStatusKeys.length > 0) {
      result = result.filter(mission => {
        const key = merged.keyByStatusId.get(mission.statusId);
        return key !== undefined && selectedStatusKeySet.has(key);
      });
    }
    if (selectedTagIds.length > 0) {
      result = result.filter(mission =>
        getMissionTags(mission).some(tag => selectedTagIdSet.has(tag.id))
      );
    }
    return result;
  }, [
    missions,
    merged.keyByStatusId,
    selectedWorkspaceIds.length,
    selectedWorkspaceIdSet,
    selectedStatusKeys.length,
    selectedStatusKeySet,
    selectedTagIds.length,
    selectedTagIdSet
  ]);

  const isTagFilterActive = selectedTagIds.length > 0;
  const isStatusFilterActive = selectedStatusKeys.length > 0;
  const isWorkspaceFilterActive = selectedWorkspaceIds.length > 0;
  const isFilterActive = isTagFilterActive || isStatusFilterActive || isWorkspaceFilterActive;

  const visibleStatusColumns = useMemo(
    () =>
      isStatusFilterActive
        ? merged.columns.filter(column => selectedStatusKeySet.has(column.key))
        : merged.columns,
    [isStatusFilterActive, merged.columns, selectedStatusKeySet]
  );

  const clearFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedStatusKeys([]);
    setSelectedWorkspaceIds([]);
  }, []);

  // Bucket every mission into its merged column (like-named statuses across
  // workspaces collapse into one). Any mission whose status isn't an active
  // column falls into the Uncategorized bucket.
  const { columns: baseColumns, uncategorized } = useMemo(
    () => groupMissionsByMergedColumn(missions, merged.keyByStatusId),
    [missions, merged.keyByStatusId]
  );

  const defaultCreateProjectId = useMemo(() => {
    const lastUsedProjectId = readLastUsedProjectId();
    if (lastUsedProjectId && projects.some(project => project.id === lastUsedProjectId)) {
      return lastUsedProjectId;
    }
    return projects[0]?.id ?? '';
  }, [projects]);

  // Every merged column key gets a slot (even empty ones) so cards can be dropped
  // into currently-empty columns.
  const columnsForDnd = useMemo<ColumnMap>(() => {
    const cols: ColumnMap = {};
    for (const column of merged.columns) cols[column.key] = baseColumns[column.key] ?? [];
    if (uncategorized.length > 0) cols[UNCATEGORIZED_ID] = uncategorized;
    return cols;
  }, [merged.columns, baseColumns, uncategorized]);

  const filteredColumns = useMemo<ColumnMap>(() => {
    const visibleMissionIds = new Set(filteredMissions.map(mission => mission.id));
    const map: ColumnMap = {};
    for (const column of merged.columns) {
      map[column.key] = (baseColumns[column.key] ?? []).filter(id => visibleMissionIds.has(id));
    }
    const filteredUncategorized = uncategorized.filter(id => visibleMissionIds.has(id));
    if (filteredUncategorized.length > 0) {
      map[UNCATEGORIZED_ID] = filteredUncategorized;
    }
    return map;
  }, [merged.columns, baseColumns, filteredMissions, uncategorized]);

  // Persist a drop. My Missions merges columns across workspaces, so a drop into a
  // merged column resolves to the concrete status in the moved card's *own*
  // workspace (the reorder endpoint is workspace-scoped). When that workspace has
  // no status with the column's name, the move is rejected with an error modal.
  const onDrop = useCallback(
    async ({ movedMissionId, dropColumnKey, orderedMissionIds }: MyMissionsDropTarget) => {
      const mission = missionById.get(movedMissionId);
      const column = merged.byKey.get(dropColumnKey);
      // Dropped into Uncategorized (no status) or an unknown card: nothing to
      // persist. Reject so the DnD hook rolls the optimistic move back.
      if (!mission || !column) throw new Error('drop-noop');

      const plan = resolveMergedColumnReorder(column, mission, orderedMissionIds, missionById);
      if (!plan) {
        setDropError({
          statusName: column.name,
          workspaceName: workspaceNameById.get(mission.workspaceId) ?? 'this'
        });
        throw new Error('status-unavailable-for-workspace');
      }

      try {
        await reorder.mutateAsync({
          statusId: plan.statusId,
          statusType: column.type,
          orderedMissionIds: plan.orderedMissionIds
        });
      } catch (error) {
        // Defensive: the server can still reject a status removed mid-drag.
        setDropError({
          statusName: column.name,
          workspaceName: workspaceNameById.get(mission.workspaceId) ?? 'this'
        });
        throw error;
      }
    },
    [missionById, merged.byKey, workspaceNameById, reorder]
  );

  const myMissionsDnd = useMyMissionsDnd({ columns: columnsForDnd, onDrop });
  const { activeId, displayColumns, dndContextProps } = myMissionsDnd;
  const visibleColumns = isFilterActive ? filteredColumns : displayColumns;

  const listDnd = useMyMissionsDnd({
    columns: visibleColumns,
    onDrop,
    draggable: !isFilterActive
  });

  // The list view groups by the same merged columns as the board, plus the
  // Uncategorized bucket when any mission's status isn't an active column.
  const listStatuses = useMemo<BoardColumnStatus[]>(() => {
    const items: BoardColumnStatus[] = visibleStatusColumns.map(column => ({
      id: column.key,
      name: column.name,
      type: column.type
    }));
    if (!isStatusFilterActive && (visibleColumns[UNCATEGORIZED_ID] ?? []).length > 0) {
      items.push({ id: UNCATEGORIZED_ID, name: 'Uncategorized', type: null });
    }
    return items;
  }, [isStatusFilterActive, visibleColumns, visibleStatusColumns]);

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
  // `complete`-type status of that mission's *own* workspace, mirroring the board.
  const handleCompleteMission = useCallback(
    (missionId: string) => {
      const mission = missionById.get(missionId);
      if (!mission) return;
      const completeStatusId = (statusesByWorkspace.get(mission.workspaceId) ?? []).find(
        status => status.type === 'complete'
      )?.id;
      if (!completeStatusId) return;
      void setMissionStatus.mutateAsync({ missionId, statusId: completeStatusId });
    },
    [missionById, statusesByWorkspace, setMissionStatus]
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

  // Board columns are keyed by merged-column name; resolve back to the concrete
  // status in the target project's workspace before creating. When that workspace
  // lacks a status with this name, the mission lands in its default status.
  const createMissionInColumn = useCallback(
    async (
      columnKey: string,
      objective: string,
      options?: BlankMissionCreateOptions
    ): Promise<{ missionId: string }> => {
      const targetProjectId = options?.projectId ?? defaultCreateProjectId;
      if (!targetProjectId) throw new Error('Choose a project before creating a mission.');

      const targetWorkspaceId =
        projects.find(project => project.id === targetProjectId)?.workspaceId ?? activeWorkspaceId;
      const statusId =
        columnKey && targetWorkspaceId
          ? merged.byKey.get(columnKey)?.statusIdByWorkspace.get(targetWorkspaceId)
          : undefined;

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
    [createMission, defaultCreateProjectId, projects, activeWorkspaceId, merged.byKey]
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

  const statusesLoading = statusQueries.some(query => query.isLoading);
  if (meta.isLoading || myMissionsQ.isLoading || projectsQ.isLoading || statusesLoading) {
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
      {visibleStatusColumns.map(column => {
        const colMissions = resolveColumnMissions(visibleColumns[column.key] ?? [], missionById);
        return (
          <MyMissionsColumn
            key={column.key}
            droppableId={column.key}
            title={column.name}
            type={column.type}
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
            <MissionWorkspaceFilterDropdown
              workspaces={workspaceFilterOptions}
              selectedWorkspaceIds={selectedWorkspaceIds}
              onClear={() => setSelectedWorkspaceIds([])}
              onToggle={workspaceId =>
                setSelectedWorkspaceIds(current =>
                  current.includes(workspaceId)
                    ? current.filter(id => id !== workspaceId)
                    : [...current, workspaceId]
                )
              }
            />
            <MissionStatusFilterDropdown
              statuses={statusFilterOptions}
              selectedStatusIds={selectedStatusKeys}
              onClear={() => setSelectedStatusKeys([])}
              onToggle={statusKey =>
                setSelectedStatusKeys(current =>
                  current.includes(statusKey)
                    ? current.filter(key => key !== statusKey)
                    : [...current, statusKey]
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

      <div className="min-h-0 flex-1 overflow-auto pt-3 px-5">
        {missions.length === 0 ? (
          <EmptyState
            title="No missions are assigned to you"
            hint="Missions assigned to you across your workspaces show up here, grouped by status."
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
        ) : view === 'board' ? (
          <DndContext {...(isFilterActive ? listDnd.dndContextProps : dndContextProps)}>
            <div className="flex h-full min-h-0 items-stretch gap-2">
              {renderColumns(!isFilterActive)}
            </div>
            {!isFilterActive ? (
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
            ) : null}
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
            onCompleteMission={handleCompleteMission}
          />
        )}
      </div>

      <Dialog
        open={dropError !== null}
        onOpenChange={open => {
          if (!open) setDropError(null);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Can’t move this mission</DialogTitle>
            <DialogDescription>
              The “{dropError?.statusName}” status doesn’t exist in the {dropError?.workspaceName}{' '}
              workspace, so this mission can’t move there. Add a matching status to that workspace,
              or move the mission within its own workspace’s columns.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDropError(null)}>
              Got it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
