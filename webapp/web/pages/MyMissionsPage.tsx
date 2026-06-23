import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useMatch, useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { MyMissionDto, WorkspaceMemberDto, WorkspaceStatusDto } from '../../shared/contract.ts';
import { EmptyState, Spinner } from '../components/ui.tsx';
import { ApiRequestError } from '../lib/api.ts';
import {
  useMeta,
  useWorkspaceMembers,
  useWorkspaceMyMissions,
  useWorkspaceStatuses
} from '../lib/queries.ts';

import { type BoardView, type ColumnMap, resolveColumnMissions } from './board-shared.ts';
import { MyMissionsColumn } from './MyMissionsColumn.tsx';
import { SortableMissionCard } from './SortableMissionCard.tsx';
import { MissionsViewToggle } from './MissionsViewToggle.tsx';
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

  const missionMatch = useMatch({ from: '/workspace/missions/$missionId', shouldThrow: false });
  const selectedMissionId = missionMatch?.params.missionId;

  const workspaceId = meta.data?.workspace.id ?? null;
  const workspaceName = meta.data?.workspace.name ?? 'this';
  const membersQ = useWorkspaceMembers(workspaceId);

  const [view, setView] = useState<BoardView>(() => readStoredView());
  const [alert, setAlert] = useState<string | null>(null);

  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);
  const missions = useMemo(() => myMissionsQ.data?.missions ?? [], [myMissionsQ.data]);

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

  const columnsForDnd = useMemo<ColumnMap>(() => {
    const cols: ColumnMap = { ...baseColumns };
    if (uncategorized.length > 0) cols[UNCATEGORIZED_ID] = uncategorized;
    return cols;
  }, [baseColumns, uncategorized]);

  const onReorderError = useCallback(
    (status: WorkspaceStatusDto, error: unknown) => {
      setAlert(describeReorderError(status, error, workspaceName));
    },
    [workspaceName]
  );

  const { activeId, displayColumns, dndContextProps } = useMyMissionsDnd({
    columns: columnsForDnd,
    statuses,
    onReorderError
  });

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

  // Drop a stale alert once the underlying data refetches.
  useEffect(() => {
    if (!alert) return;
    const timer = window.setTimeout(() => setAlert(null), 6000);
    return () => window.clearTimeout(timer);
  }, [alert]);

  if (statusesQ.isLoading || myMissionsQ.isLoading) {
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
      {statuses.map(status => {
        const colMissions = resolveColumnMissions(displayColumns[status.id] ?? [], missionById);
        return (
          <MyMissionsColumn
            key={status.id}
            droppableId={status.id}
            title={status.name}
            type={status.type}
            missions={colMissions}
            count={colMissions.length}
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedMissionId={selectedMissionId}
            draggable={draggable}
            onOpenMission={openMission}
          />
        );
      })}
      {uncategorized.length > 0 ? (
        <MyMissionsColumn
          droppableId={UNCATEGORIZED_ID}
          title="Uncategorized"
          type={null}
          missions={resolveColumnMissions(displayColumns[UNCATEGORIZED_ID] ?? [], missionById)}
          count={(displayColumns[UNCATEGORIZED_ID] ?? []).length}
          membersByWorkspaceUserId={membersByWorkspaceUserId}
          selectedMissionId={selectedMissionId}
          draggable={draggable}
          onOpenMission={openMission}
        />
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-5 py-3">
          <h1 className="text-sm font-semibold">My Missions</h1>
          <MissionsViewToggle value={view} onChange={handleViewChange} />
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

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {missions.length === 0 ? (
          <EmptyState
            title="No missions are assigned to you"
            hint="Missions assigned to you across this workspace's projects show up here, grouped by status."
          />
        ) : view === 'board' ? (
          <DndContext {...dndContextProps}>
            <div className="flex h-full min-h-0 items-stretch gap-4">{renderColumns(true)}</div>
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
          <div className="flex flex-col gap-6">{renderColumns(false)}</div>
        )}
      </div>
    </div>
  );
}
