import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { STATUS_CONFIG } from '@/components/ui.tsx';

import type { ProjectStatusDto, TicketDto, WorkspaceMemberDto } from '../../shared/contract.ts';
import { useReorderBoardColumn } from '../lib/queries.ts';

import { type ColumnMap, columnMapsEqual } from './board-shared.ts';
import { TicketListCard } from './TicketListCard.tsx';
import { TicketListStatusGroup } from './TicketListStatusGroup.tsx';

export function TicketListView({
  statuses,
  columns,
  ticketById,
  projectId,
  projectName,
  projectColor,
  membersByWorkspaceUserId,
  selectedTicketId,
  draggable = true
}: {
  statuses: ProjectStatusDto[];
  columns: ColumnMap;
  ticketById: Map<string, TicketDto>;
  projectId: string;
  projectName: string;
  projectColor: string | null;
  membersByWorkspaceUserId: Map<string, WorkspaceMemberDto>;
  selectedTicketId?: string;
  draggable?: boolean;
}) {
  const reorder = useReorderBoardColumn();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [override, setOverride] = useState<ColumnMap | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Drop the optimistic override once the real columns catch up to it.
  useEffect(() => {
    if (activeId === null && override !== null && columnMapsEqual(override, columns)) {
      setOverride(null);
    }
  }, [activeId, override, columns]);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  // When the list is showing a filtered subset, reordering would corrupt the
  // hidden order, so disable drag activation entirely (mirrors the board view).
  const noSensors = useSensors();
  const sensors = draggable ? dndSensors : noSensors;

  const collisionDetection = useCallback((...args: Parameters<typeof pointerWithin>) => {
    const hits = pointerWithin(...args);
    return hits.length > 0 ? hits : closestCenter(...args);
  }, []);

  const toggleCollapse = useCallback((statusId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(statusId)) next.delete(statusId);
      else next.add(statusId);
      return next;
    });
  }, []);

  const displayColumns = override ?? columns;

  const findColumn = (id: string): string | undefined => {
    if (id in columns) return id;
    return Object.keys(columns).find(statusId => columns[statusId]?.includes(id));
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setOverride(columns);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeTicketId = String(active.id);
    const overId = String(over.id);
    const fromCol = findColumn(activeTicketId);
    const toCol = findColumn(overId);
    if (!fromCol || !toCol || fromCol === toCol) return;

    setOverride(prev => {
      const source = prev ?? columns;
      const fromItems = source[fromCol] ?? [];
      const toItems = source[toCol] ?? [];
      const overIndex = toItems.indexOf(overId);
      const insertAt = overIndex >= 0 ? overIndex : toItems.length;
      return {
        ...source,
        [fromCol]: fromItems.filter(id => id !== activeTicketId),
        [toCol]: [...toItems.slice(0, insertAt), activeTicketId, ...toItems.slice(insertAt)]
      };
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const id = String(active.id);
    const dropColumn = over ? findColumn(String(over.id)) : undefined;

    setActiveId(null);

    if (!dropColumn) {
      setOverride(null);
      return;
    }

    const source = override ?? columns;
    const items = source[dropColumn] ?? [];
    const fromIndex = items.indexOf(id);
    const overIndex =
      over && String(over.id) !== dropColumn ? items.indexOf(String(over.id)) : items.length - 1;
    const finalItems =
      fromIndex !== -1 && overIndex !== -1 && fromIndex !== overIndex
        ? arrayMove(items, fromIndex, overIndex)
        : items;

    const finalColumns: ColumnMap = { ...source, [dropColumn]: finalItems };
    setOverride(finalColumns);

    if (columnMapsEqual(finalColumns, columns)) {
      setOverride(null);
      return;
    }

    const status = statuses.find(s => s.id === dropColumn);
    if (!status) {
      setOverride(null);
      return;
    }

    reorder.mutate({
      projectId,
      statusId: dropColumn,
      statusType: status.type,
      orderedTicketIds: finalItems
    });
  };

  const activeTicket = activeId ? ticketById.get(activeId) : undefined;
  const activeAssignee = activeTicket?.assignedWorkspaceUserId
    ? membersByWorkspaceUserId.get(activeTicket.assignedWorkspaceUserId)
    : undefined;

  const groups = useMemo(
    () =>
      statuses.map(status => {
        const tickets = (displayColumns[status.id] ?? [])
          .map(id => ticketById.get(id))
          .filter((ticket): ticket is TicketDto => ticket !== undefined);
        return { status, tickets };
      }),
    [statuses, displayColumns, ticketById]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => {
        setActiveId(null);
        setOverride(null);
      }}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
        {groups.map(({ status, tickets }) => (
          <TicketListStatusGroup
            key={status.id}
            status={status}
            style={STATUS_CONFIG[status.type]}
            tickets={tickets}
            projectId={projectId}
            projectName={projectName}
            projectColor={projectColor}
            membersByWorkspaceUserId={membersByWorkspaceUserId}
            selectedTicketId={selectedTicketId}
            isCollapsed={collapsed.has(status.id)}
            onToggleCollapse={toggleCollapse}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTicket ? (
          <TicketListCard
            ticket={activeTicket}
            projectId={projectId}
            projectName={projectName}
            projectColor={projectColor}
            assignee={activeAssignee}
            selected={activeTicket.id === selectedTicketId}
            isDragOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
