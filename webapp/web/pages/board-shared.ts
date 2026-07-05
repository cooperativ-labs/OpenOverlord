import type {
  closestCenter,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  useSensors
} from '@dnd-kit/core';

import type { MissionDto, WorkspaceMemberDto } from '../../shared/contract.ts';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const BOARD_VIEW_STORAGE_PREFIX = 'overlord:project-board-view:';

export type BoardView = 'board' | 'list';
export type ColumnMap = Record<string, string[]>;

/**
 * Shared shape returned by the board/column drag-and-drop hooks
 * (`useBoardColumnDnd`, `useMyMissionsDnd`). Both the project board and My
 * Missions own their hook instance at the page level — since each persists
 * reordering through a different mutation (project- vs workspace-scoped) —
 * and pass the resulting state down to the presentational `MissionListView`.
 */
export type BoardDndResult = {
  activeId: string | null;
  displayColumns: ColumnMap;
  dndContextProps: {
    sensors: ReturnType<typeof useSensors>;
    collisionDetection: typeof closestCenter;
    onDragStart: (event: DragStartEvent) => void;
    onDragOver: (event: DragOverEvent) => void;
    onDragEnd: (event: DragEndEvent) => void;
    onDragCancel: () => void;
  };
};

export type MissionTagFilterOption = { id: string; label: string; color: string | null };

export function getMissionTags(mission: MissionDto): MissionTagFilterOption[] {
  if (!Array.isArray(mission.tags)) return [];

  return mission.tags
    .map(tag => {
      const id = tag.id?.trim();
      if (!id) return null;
      return {
        id,
        label: tag.label?.trim() || id,
        color: tag.color ?? null
      };
    })
    .filter((tag): tag is MissionTagFilterOption => tag !== null);
}

export function getTagFilterLabel(
  selectedTagIds: string[],
  tagOptions: MissionTagFilterOption[]
): string {
  if (selectedTagIds.length === 0) return 'All';
  if (selectedTagIds.length === 1) {
    return tagOptions.find(tag => tag.id === selectedTagIds[0])?.label ?? 'Tag';
  }
  return `${selectedTagIds.length} tags`;
}

export function getStatusFilterLabel(
  selectedStatusIds: string[],
  statuses: Array<{ id: string; name: string }>
): string {
  if (selectedStatusIds.length === 0) return 'All';
  if (selectedStatusIds.length === 1) {
    return statuses.find(status => status.id === selectedStatusIds[0])?.name ?? 'Status';
  }
  return `${selectedStatusIds.length} statuses`;
}

export function getWorkspaceFilterLabel(
  selectedWorkspaceIds: string[],
  workspaces: Array<{ id: string; name: string }>
): string {
  if (selectedWorkspaceIds.length === 0) return 'All';
  if (selectedWorkspaceIds.length === 1) {
    return (
      workspaces.find(workspace => workspace.id === selectedWorkspaceIds[0])?.name ?? 'Workspace'
    );
  }
  return `${selectedWorkspaceIds.length} workspaces`;
}

export function readStoredBoardView(projectId: string): BoardView {
  if (typeof window === 'undefined') return 'board';
  try {
    const value = window.localStorage.getItem(`${BOARD_VIEW_STORAGE_PREFIX}${projectId}`);
    return value === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

export function storeBoardView(projectId: string, view: BoardView) {
  try {
    window.localStorage.setItem(`${BOARD_VIEW_STORAGE_PREFIX}${projectId}`, view);
  } catch {
    // Ignore private browsing or quota failures; view switching still works in memory.
  }
}

/** Look up a mission's assignee from the workspace member map, if it has one. */
export function resolveAssignee(
  mission: MissionDto,
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>
): WorkspaceMemberDto | undefined {
  return mission.assignedWorkspaceUserId
    ? membersByWorkspaceUserId.get(mission.assignedWorkspaceUserId)
    : undefined;
}

/** Resolve an ordered column of mission ids into the missions, dropping any unknown ids. */
export function resolveColumnMissions<T extends { id: string }>(
  missionIds: string[],
  missionById: Map<string, T>
): T[] {
  return missionIds
    .map(id => missionById.get(id))
    .filter((mission): mission is T => mission !== undefined);
}

export function columnMapsEqual(a: ColumnMap, b: ColumnMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(k => {
    const av = a[k];
    const bv = b[k];
    return bv !== undefined && av.length === bv.length && av.every((id, i) => id === bv[i]);
  });
}
