import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  ExecutionRequestDto,
  ObjectiveDto,
  TicketDetailDto
} from '../../../shared/contract.ts';
import { useReorderFutureObjectives } from '../../lib/queries.ts';
import { cn } from '../../lib/utils.ts';

import { DraftObjective } from './DraftObjective.tsx';
import { ObjectiveCollapsibleItem } from './ObjectiveCollapsibleItem.tsx';

const EDITABLE_STATES = new Set(['draft', 'submitted', 'launching']);

/**
 * A future objective wrapped for drag-and-drop reordering. Mirrors the kanban
 * board's `useSortable` setup: the grip handle owns the drag listeners so the
 * objective card's own inline editing stays fully interactive. The editable
 * card itself is the existing {@link DraftObjective}, which already renders the
 * collapsed future styling and the Promote action.
 */
function SortableFutureObjective({
  objective,
  siblings,
  executionRequests
}: {
  objective: ObjectiveDto;
  siblings: ObjectiveDto[];
  executionRequests: ExecutionRequestDto[];
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: objective.id
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative flex items-stretch gap-2', isDragging && 'z-10 opacity-70')}
    >
      <button
        type="button"
        aria-label="Reorder future objective"
        className="flex w-5 shrink-0 cursor-grab touch-none items-center justify-center self-stretch rounded text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">
        <DraftObjective
          objective={objective}
          siblings={siblings}
          executionRequests={executionRequests}
        />
      </div>
    </div>
  );
}

/**
 * The ticket panel's objective list, split into three groups:
 *
 * 1. **Executed** (executing / pending delivery / complete) — read-first
 *    {@link ObjectiveCollapsibleItem}s.
 * 2. **Editable** (draft / submitted / launching) — full {@link DraftObjective}
 *    launch cards.
 * 3. **Future** — {@link DraftObjective} cards made sortable via dnd-kit so they
 *    can be reordered; the new order is persisted optimistically.
 */
export function TicketObjectivesSection({ ticket }: { ticket: TicketDetailDto }) {
  const reorder = useReorderFutureObjectives();

  // `objectives` arrives position-ordered from the server, so a stable filter
  // preserves that order for the non-future groups.
  const objectives = ticket.objectives;

  const executedObjectives = useMemo(
    () =>
      objectives.filter(
        o =>
          (o.state === 'executing' ||
            o.state === 'pending_delivery' ||
            o.state === 'complete') &&
          o.instructionText.trim().length > 0
      ),
    [objectives]
  );

  const editableObjectives = useMemo(
    () => objectives.filter(o => EDITABLE_STATES.has(o.state)),
    [objectives]
  );

  const futureObjectivesFromServer = useMemo(
    () => objectives.filter(o => o.state === 'future'),
    [objectives]
  );

  // Locally-mirrored order for optimistic drag-and-drop. We resync from the
  // server whenever the *set* of future objective ids changes; updates that only
  // shuffle positions are ignored so a dragged item does not jump back before
  // our reorder lands.
  const [futureOrder, setFutureOrder] = useState<string[]>(() =>
    futureObjectivesFromServer.map(o => o.id)
  );

  useEffect(() => {
    const incomingIds = futureObjectivesFromServer.map(o => o.id);
    setFutureOrder(previous => {
      const previousSet = new Set(previous);
      const incomingSet = new Set(incomingIds);
      const sameMembership =
        previous.length === incomingIds.length && previous.every(id => incomingSet.has(id));
      if (sameMembership) return previous;
      const kept = previous.filter(id => incomingSet.has(id));
      const additions = incomingIds.filter(id => !previousSet.has(id));
      return [...kept, ...additions];
    });
  }, [futureObjectivesFromServer]);

  const orderedFutureObjectives = useMemo(() => {
    const byId = new Map(futureObjectivesFromServer.map(o => [o.id, o]));
    return futureOrder
      .map(id => byId.get(id))
      .filter((o): o is ObjectiveDto => Boolean(o));
  }, [futureObjectivesFromServer, futureOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = futureOrder.indexOf(String(active.id));
    const newIndex = futureOrder.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    const nextOrder = arrayMove(futureOrder, oldIndex, newIndex);
    setFutureOrder(nextOrder);
    reorder.mutate(
      { ticketId: ticket.id, orderedObjectiveIds: nextOrder },
      {
        onError: () => setFutureOrder(futureObjectivesFromServer.map(o => o.id))
      }
    );
  }

  const hasNonExecuted = editableObjectives.length > 0 || orderedFutureObjectives.length > 0;

  return (
    <div className="space-y-3">
      {executedObjectives.length > 0 ? (
        <div className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)]">
          {executedObjectives.map((objective, index) => (
            <ObjectiveCollapsibleItem key={objective.id} objective={objective} index={index} />
          ))}
        </div>
      ) : null}

      {hasNonExecuted ? (
        <div className="space-y-3">
          {editableObjectives.map(objective => (
            <DraftObjective
              key={objective.id}
              objective={objective}
              siblings={objectives}
              executionRequests={ticket.executionRequests}
            />
          ))}

          {orderedFutureObjectives.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={orderedFutureObjectives.map(o => o.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-3">
                  {orderedFutureObjectives.map(objective => (
                    <SortableFutureObjective
                      key={objective.id}
                      objective={objective}
                      siblings={objectives}
                      executionRequests={ticket.executionRequests}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
