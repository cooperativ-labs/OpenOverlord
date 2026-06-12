import type { TicketDto } from '../../shared/contract.ts';

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const BOARD_VIEW_STORAGE_PREFIX = 'overlord:project-board-view:';

export type BoardView = 'board' | 'list';
export type ColumnMap = Record<string, string[]>;

export type TicketTagFilterOption = { id: string; label: string; color: string | null };
type TicketTagValue =
  | string
  | { id?: string; label?: string; name?: string; color?: string | null };
type TicketWithOptionalTags = TicketDto & {
  tags?: TicketTagValue[];
};

export function getTicketTags(ticket: TicketDto): TicketTagFilterOption[] {
  const rawTags = (ticket as TicketWithOptionalTags).tags;
  if (!Array.isArray(rawTags)) return [];

  return rawTags
    .map(tag => {
      if (typeof tag === 'string') return { id: tag, label: tag, color: null };
      const id = tag.id?.trim();
      if (!id) return null;
      return {
        id,
        label: tag.label?.trim() || tag.name?.trim() || id,
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

export function columnMapsEqual(a: ColumnMap, b: ColumnMap): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(k => {
    const av = a[k];
    const bv = b[k];
    return bv !== undefined && av.length === bv.length && av.every((id, i) => id === bv[i]);
  });
}
