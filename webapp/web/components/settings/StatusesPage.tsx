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
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Badge, STATUS_LABEL, statusClasses } from '@/components/ui.tsx';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  useCreateWorkspaceStatus,
  useDeleteWorkspaceStatus,
  useReorderWorkspaceStatuses,
  useUpdateWorkspaceStatus,
  useWorkspaceStatuses
} from '@/lib/queries';
import { cn } from '@/lib/utils';

import type { StatusType, WorkspaceStatusDto } from '../../../shared/contract.ts';

const ADDABLE_STATUS_TYPES: StatusType[] = [
  'draft',
  'complete',
  'blocked',
  'cancelled',
  'execute',
  'review'
];

function SortableStatusRow({
  status,
  updateStatus,
  reorderStatuses,
  onSetDefault,
  onRename,
  onDelete,
  canDelete
}: {
  status: WorkspaceStatusDto;
  updateStatus: ReturnType<typeof useUpdateWorkspaceStatus>;
  reorderStatuses: ReturnType<typeof useReorderWorkspaceStatuses>;
  onSetDefault: (status: WorkspaceStatusDto) => void;
  onRename: (status: WorkspaceStatusDto, name: string) => void;
  onDelete: (status: WorkspaceStatusDto) => void;
  canDelete: (status: WorkspaceStatusDto) => boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: status.id });

  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('border-t', isDragging && 'z-10 bg-muted/30 opacity-70')}
    >
      <td className="w-8 px-2 py-2">
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Reorder ${status.name}`}
          disabled={reorderStatuses.isPending}
          className="flex size-7 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      </td>
      <td className="px-3 py-2">
        <Input
          defaultValue={status.name}
          className="h-8"
          disabled={updateStatus.isPending}
          onBlur={event => void onRename(status, event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
        />
      </td>
      <td className="px-3 py-2">
        <Badge className={statusClasses(status.type)}>{STATUS_LABEL[status.type]}</Badge>
      </td>
      <td className="px-3 py-2">
        {status.type === 'draft' ? (
          <Button
            type="button"
            size="sm"
            variant={status.isDefault ? 'secondary' : 'ghost'}
            className="h-7"
            disabled={status.isDefault || updateStatus.isPending}
            onClick={() => void onSetDefault(status)}
          >
            {status.isDefault ? 'Default' : 'Set default'}
          </Button>
        ) : status.type === 'execute' || status.type === 'review' ? (
          <span className="text-muted-foreground">Exclusive</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {canDelete(status) ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 text-destructive hover:text-destructive"
            onClick={() => onDelete(status)}
            aria-label={`Delete ${status.name}`}
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Card-status manager. Pass `workspaceId` to manage a specific (possibly
 * non-active) workspace's statuses via the workspace-scoped routes; omit it to
 * manage the active workspace (coo:135).
 */
export function StatusesPage({ workspaceId }: { workspaceId?: string | null } = {}) {
  const statusesQ = useWorkspaceStatuses(workspaceId);
  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);
  const ordered = useMemo(() => [...statuses].sort((a, b) => a.position - b.position), [statuses]);
  const createStatus = useCreateWorkspaceStatus(workspaceId);
  const updateStatus = useUpdateWorkspaceStatus(workspaceId);
  const deleteStatus = useDeleteWorkspaceStatus(workspaceId);
  const reorderStatuses = useReorderWorkspaceStatuses(workspaceId);

  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<StatusType>('draft');
  const [addError, setAddError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceStatusDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [statusOrder, setStatusOrder] = useState<string[]>(() => ordered.map(status => status.id));

  useEffect(() => {
    const incomingIds = ordered.map(status => status.id);
    setStatusOrder(previous => {
      const previousSet = new Set(previous);
      const incomingSet = new Set(incomingIds);
      const sameMembership =
        previous.length === incomingIds.length && previous.every(id => incomingSet.has(id));
      if (sameMembership) return previous;
      const kept = previous.filter(id => incomingSet.has(id));
      const additions = incomingIds.filter(id => !previousSet.has(id));
      return [...kept, ...additions];
    });
  }, [ordered]);

  const orderedStatuses = useMemo(() => {
    const byId = new Map(ordered.map(status => [status.id, status]));
    return statusOrder
      .map(id => byId.get(id))
      .filter((status): status is WorkspaceStatusDto => Boolean(status));
  }, [ordered, statusOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const hasExecute = ordered.some(status => status.type === 'execute');
  const hasReview = ordered.some(status => status.type === 'review');

  const addableTypes = ADDABLE_STATUS_TYPES.filter(type => {
    if (type === 'execute') return !hasExecute;
    if (type === 'review') return !hasReview;
    return true;
  });

  async function handleRename(status: WorkspaceStatusDto, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === status.name) return;

    setRowError(null);
    try {
      await updateStatus.mutateAsync({ statusId: status.id, body: { name: trimmed } });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to rename status.');
    }
  }

  async function handleSetDefault(status: WorkspaceStatusDto) {
    if (status.isDefault || status.type !== 'draft') return;

    setRowError(null);
    try {
      await updateStatus.mutateAsync({ statusId: status.id, body: { isDefault: true } });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to set default status.');
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = statusOrder.indexOf(String(active.id));
    const newIndex = statusOrder.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    const nextOrder = arrayMove(statusOrder, oldIndex, newIndex);
    setStatusOrder(nextOrder);
    setRowError(null);

    reorderStatuses.mutate(
      { orderedStatusIds: nextOrder },
      {
        onError: error => {
          setStatusOrder(ordered.map(status => status.id));
          setRowError(error instanceof Error ? error.message : 'Failed to reorder statuses.');
        }
      }
    );
  }

  async function handleAddStatus() {
    const trimmed = newName.trim();
    if (!trimmed) {
      setAddError('Enter a status name.');
      return;
    }

    setAddError(null);
    try {
      await createStatus.mutateAsync({ name: trimmed, type: newType });
      setNewName('');
      setNewType('draft');
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Failed to add status.');
    }
  }

  async function handleDeleteStatus() {
    if (!deleteTarget) return;

    setDeleteError(null);
    try {
      await deleteStatus.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete status.');
    }
  }

  function canDelete(status: WorkspaceStatusDto): boolean {
    return status.type !== 'execute' && status.type !== 'review' && !status.isDefault;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Card statuses</h2>
        <p className="text-sm text-muted-foreground">
          Board columns shared across every project in this workspace. Rename, reorder, add, or
          remove statuses. Type semantics are fixed; exactly one execute and one review status are
          required.
        </p>
      </div>

      {orderedStatuses.length === 0 ? (
        <p className="text-sm text-muted-foreground">No statuses configured.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 px-2 py-2" aria-label="Reorder" />
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Default</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <SortableContext items={statusOrder} strategy={verticalListSortingStrategy}>
                <tbody>
                  {orderedStatuses.map(status => (
                    <SortableStatusRow
                      key={status.id}
                      status={status}
                      updateStatus={updateStatus}
                      reorderStatuses={reorderStatuses}
                      onSetDefault={status => void handleSetDefault(status)}
                      onRename={(status, name) => void handleRename(status, name)}
                      onDelete={status => {
                        setDeleteError(null);
                        setDeleteTarget(status);
                      }}
                      canDelete={canDelete}
                    />
                  ))}
                </tbody>
              </SortableContext>
            </table>
          </DndContext>
        </div>
      )}

      {rowError ? <p className="text-xs text-destructive">{rowError}</p> : null}

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-medium">Add status</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          New missions use the default draft status unless another is chosen at creation time.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="grid min-w-[12rem] gap-1.5">
            <Label htmlFor="new-status-name">Name</Label>
            <Input
              id="new-status-name"
              value={newName}
              onChange={event => setNewName(event.target.value)}
              placeholder="e.g. Icebox"
              className="h-8"
              onKeyDown={event => {
                if (event.key === 'Enter') void handleAddStatus();
              }}
            />
          </div>
          <div className="grid min-w-40 gap-1.5">
            <Label htmlFor="new-status-type">Type</Label>
            <Select value={newType} onValueChange={value => setNewType(value as StatusType)}>
              <SelectTrigger id="new-status-type" className="h-8">
                <SelectValue>{STATUS_LABEL[newType]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {addableTypes.map(type => (
                  <SelectItem key={type} value={type}>
                    {STATUS_LABEL[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            disabled={createStatus.isPending}
            onClick={() => void handleAddStatus()}
          >
            <Plus className="size-3.5" />
            Add status
          </Button>
        </div>
        {addError ? <p className="mt-2 text-xs text-destructive">{addError}</p> : null}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete status</DialogTitle>
            <DialogDescription>
              Remove &ldquo;{deleteTarget?.name}&rdquo; from this workspace? Missions must be moved
              off this column first.
            </DialogDescription>
          </DialogHeader>
          {deleteError ? <p className="text-sm text-destructive">{deleteError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteStatus.isPending}
              onClick={() => void handleDeleteStatus()}
            >
              Delete status
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
