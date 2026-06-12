import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

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
  useCreateProjectStatus,
  useDeleteProjectStatus,
  useReorderProjectStatuses,
  useUpdateProjectStatus
} from '@/lib/queries';

import type { ProjectStatusDto, StatusType } from '../../../../shared/contract.ts';

const ADDABLE_STATUS_TYPES: StatusType[] = [
  'draft',
  'complete',
  'blocked',
  'cancelled',
  'execute',
  'review'
];

type WorkflowPageProps = {
  projectId: string;
  statuses: ProjectStatusDto[];
};

export function WorkflowPage({ projectId, statuses }: WorkflowPageProps) {
  const ordered = useMemo(() => [...statuses].sort((a, b) => a.position - b.position), [statuses]);
  const createStatus = useCreateProjectStatus(projectId);
  const updateStatus = useUpdateProjectStatus(projectId);
  const deleteStatus = useDeleteProjectStatus(projectId);
  const reorderStatuses = useReorderProjectStatuses(projectId);

  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<StatusType>('draft');
  const [addError, setAddError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectStatusDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const hasExecute = ordered.some(status => status.type === 'execute');
  const hasReview = ordered.some(status => status.type === 'review');

  const addableTypes = ADDABLE_STATUS_TYPES.filter(type => {
    if (type === 'execute') return !hasExecute;
    if (type === 'review') return !hasReview;
    return true;
  });

  async function handleRename(status: ProjectStatusDto, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === status.name) return;

    setRowError(null);
    try {
      await updateStatus.mutateAsync({ statusId: status.id, body: { name: trimmed } });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to rename status.');
    }
  }

  async function handleSetDefault(status: ProjectStatusDto) {
    if (status.isDefault || status.type !== 'draft') return;

    setRowError(null);
    try {
      await updateStatus.mutateAsync({ statusId: status.id, body: { isDefault: true } });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to set default status.');
    }
  }

  async function handleMove(status: ProjectStatusDto, direction: 'up' | 'down') {
    const index = ordered.findIndex(item => item.id === status.id);
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= ordered.length) return;

    const nextOrder = ordered.map(item => item.id);
    [nextOrder[index], nextOrder[swapIndex]] = [nextOrder[swapIndex], nextOrder[index]];

    setRowError(null);
    try {
      await reorderStatuses.mutateAsync({ orderedStatusIds: nextOrder });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to reorder statuses.');
    }
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

  function canDelete(status: ProjectStatusDto): boolean {
    return status.type !== 'execute' && status.type !== 'review' && !status.isDefault;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Workflow / statuses</h2>
        <p className="text-sm text-muted-foreground">
          Board columns for this project. Rename, reorder, add, or remove statuses. Type semantics
          are fixed; exactly one execute and one review status are required.
        </p>
      </div>

      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No statuses configured.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Default</th>
                <th className="px-3 py-2 font-medium">Order</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {ordered.map((status, index) => (
                <tr key={status.id} className="border-t">
                  <td className="px-3 py-2">
                    <Input
                      defaultValue={status.name}
                      className="h-8"
                      disabled={updateStatus.isPending}
                      onBlur={event => void handleRename(status, event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Badge className={statusClasses(status.type)}>
                      {STATUS_LABEL[status.type]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2">
                    {status.type === 'draft' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant={status.isDefault ? 'secondary' : 'ghost'}
                        className="h-7"
                        disabled={status.isDefault || updateStatus.isPending}
                        onClick={() => void handleSetDefault(status)}
                      >
                        {status.isDefault ? 'Default' : 'Set default'}
                      </Button>
                    ) : status.type === 'execute' || status.type === 'review' ? (
                      <span className="text-muted-foreground">Exclusive</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        disabled={index === 0 || reorderStatuses.isPending}
                        onClick={() => void handleMove(status, 'up')}
                        aria-label={`Move ${status.name} up`}
                      >
                        <ChevronUp className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        disabled={index === ordered.length - 1 || reorderStatuses.isPending}
                        onClick={() => void handleMove(status, 'down')}
                        aria-label={`Move ${status.name} down`}
                      >
                        <ChevronDown className="size-4" />
                      </Button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canDelete(status) ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-7 text-destructive hover:text-destructive"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleteTarget(status);
                        }}
                        aria-label={`Delete ${status.name}`}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rowError ? <p className="text-xs text-destructive">{rowError}</p> : null}

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-medium">Add status</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          New tickets use the default draft status unless another is chosen at creation time.
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
          <div className="grid min-w-[10rem] gap-1.5">
            <Label htmlFor="new-status-type">Type</Label>
            <Select value={newType} onValueChange={value => setNewType(value as StatusType)}>
              <SelectTrigger id="new-status-type" className="h-8">
                <SelectValue />
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
              Remove &ldquo;{deleteTarget?.name}&rdquo; from this project? Tickets must be moved off
              this column first.
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
