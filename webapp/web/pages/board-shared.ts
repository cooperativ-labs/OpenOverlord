import type { TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const BOARD_VIEW_STORAGE_PREFIX = 'overlord:project-board-view:';

export type BoardView = 'board' | 'list';
export type ColumnMap = Record<string, string[]>;

export type TicketTagFilterOption = { id: string; label: string; color: string | null };

export function getTicketTags(ticket: TicketDto): TicketTagFilterOption[] {
  if (!Array.isArray(ticket.tags)) return [];

  return ticket.tags
    .map(tag => {
      const id = tag.id?.trim();
      if (!id) return null;
      return {
        id,
        label: tag.label?.trim() || id,
        color: tag.color ?? null
      };
    })
    .filter((tag): tag is TicketTagFilterOption => tag !== null);
}

export function getTagFilterLabel(
  selectedTagIds: string[],
  tagOptions: TicketTagFilterOption[]
): string {
  if (selectedTagIds.length === 0) return 'All';
  if (selectedTagIds.length === 1) {
    return tagOptions.find(tag => tag.id === selectedTagIds[0])?.label ?? 'Tag';
  }
  return `${selectedTagIds.length} tags`;
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

/** Look up a ticket's assignee from the workspace member map, if it has one. */
export function resolveAssignee(
  ticket: TicketDto,
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>
): WorkspaceMemberDto | undefined {
  return ticket.assignedWorkspaceUserId
    ? membersByWorkspaceUserId.get(ticket.assignedWorkspaceUserId)
    : undefined;
}

/** Resolve an ordered column of ticket ids into the tickets, dropping any unknown ids. */
export function resolveColumnTickets<T extends { id: string }>(
  ticketIds: string[],
  ticketById: Map<string, T>
): T[] {
  return ticketIds
    .map(id => ticketById.get(id))
    .filter((ticket): ticket is T => ticket !== undefined);
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
