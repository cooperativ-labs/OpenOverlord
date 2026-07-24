import { Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
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
import { type ButtonLoadingState, LoadingButton } from '@/components/ui/loading-button';
import {
  useDeleteWorkspaceExecutionTarget,
  useRenameWorkspaceExecutionTarget,
  useWorkspaceExecutionTargets,
  useWorkspaceMembers
} from '@/lib/queries';

import type { WorkspaceExecutionTargetDto } from '../../../../shared/contract.ts';

function targetStatusLabel(status: string, reachable: boolean): string {
  if (status !== 'active') return status;
  return reachable ? 'online' : 'offline';
}

function ExecutionTargetNameEditor({
  workspaceId,
  target
}: {
  workspaceId: string;
  target: WorkspaceExecutionTargetDto;
}) {
  const rename = useRenameWorkspaceExecutionTarget(workspaceId);
  const [label, setLabel] = useState(target.label);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const trimmed = label.trim();
  const isDirty = trimmed !== target.label && trimmed.length > 0;

  async function handleSave() {
    if (!isDirty) return;
    setSaveState('loading');
    setError(null);
    try {
      await rename.mutateAsync({ executionTargetId: target.id, label: trimmed });
      setSaveState('success');
      setTimeout(() => setSaveState('default'), 1200);
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to rename execution target.');
    }
  }

  return (
    <div className="space-y-1.5">
      <Label
        htmlFor={`execution-target-name-${target.id}`}
        className="text-xs text-muted-foreground"
      >
        Name
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={`execution-target-name-${target.id}`}
          value={label}
          onChange={event => {
            setLabel(event.target.value);
            setError(null);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') void handleSave();
          }}
          className="h-8 max-w-sm"
        />
        <LoadingButton
          buttonState={saveState}
          text="Save"
          loadingText="Saving…"
          successText="Saved"
          errorText="Retry"
          size="sm"
          className="h-8"
          disabled={!isDirty}
          onClick={() => void handleSave()}
        />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function ExecutionTargetsPage({ workspaceId }: { workspaceId: string }) {
  const targets = useWorkspaceExecutionTargets(workspaceId);
  const members = useWorkspaceMembers(workspaceId);
  const deleteTarget = useDeleteWorkspaceExecutionTarget(workspaceId);
  const operator = (members.data ?? []).find(member => member.isOperator);
  const canManageTargets = operator?.isAdmin ?? false;

  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(new Set());
  const [deleteTargetRows, setDeleteTargetRows] = useState<WorkspaceExecutionTargetDto[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteState, setDeleteState] = useState<ButtonLoadingState>('default');

  const targetIds = targets.data?.map(target => target.id) ?? [];
  const selectedTargetCount = targetIds.filter(id => selectedTargetIds.has(id)).length;
  const allTargetsSelected = targetIds.length > 0 && selectedTargetCount === targetIds.length;

  function toggleTargetSelection(targetId: string, checked: boolean) {
    setSelectedTargetIds(current => {
      const next = new Set(current);
      if (checked) {
        next.add(targetId);
      } else {
        next.delete(targetId);
      }
      return next;
    });
  }

  function toggleAllTargetSelections(checked: boolean) {
    setSelectedTargetIds(checked ? new Set(targetIds) : new Set());
  }

  async function handleDeleteTarget() {
    if (!deleteTargetRows.length) return;

    setDeleteState('loading');
    setDeleteError(null);
    const results = await Promise.allSettled(
      deleteTargetRows.map(target => deleteTarget.mutateAsync(target.id))
    );
    const failedTargets = deleteTargetRows.filter(
      (_, index) => results[index].status === 'rejected'
    );

    setSelectedTargetIds(current => {
      const next = new Set(current);
      for (const target of deleteTargetRows) {
        if (!failedTargets.includes(target)) next.delete(target.id);
      }
      return next;
    });

    if (!failedTargets.length) {
      setDeleteState('success');
      setDeleteTargetRows([]);
      setTimeout(() => setDeleteState('default'), 1200);
      return;
    }

    const firstFailure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    setDeleteState('error');
    setDeleteTargetRows(failedTargets);
    setDeleteError(
      failedTargets.length === 1
        ? firstFailure?.reason instanceof Error
          ? firstFailure.reason.message
          : 'Failed to delete execution target.'
        : `Failed to delete ${failedTargets.length} execution targets. ${
            firstFailure?.reason instanceof Error ? firstFailure.reason.message : ''
          }`.trim()
    );
  }

  if (targets.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading execution targets…</p>;
  }

  if (targets.isError) {
    return (
      <p className="text-sm text-destructive">
        {targets.error instanceof Error
          ? targets.error.message
          : 'Failed to load execution targets.'}
      </p>
    );
  }

  if (!targets.data?.length) {
    return (
      <div className="space-y-2">
        <h2 className="text-base font-medium">Execution targets</h2>
        <p className="text-sm text-muted-foreground">
          No execution targets have connected to this workspace yet. A target appears when a
          workspace member configures a local runner or a virtual gateway registers here.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-medium">Execution targets</h2>
          <p className="text-sm text-muted-foreground">
            Targets belong to this workspace. Expand one to see who can use it and its current
            availability; connection details and credentials stay private to the target.
            {canManageTargets
              ? ' Workspace admins can remove stale or unused targets.'
              : ' Only workspace admins can remove targets.'}
          </p>
        </div>

        {canManageTargets ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allTargetsSelected}
                ref={input => {
                  if (input) input.indeterminate = selectedTargetCount > 0 && !allTargetsSelected;
                }}
                onChange={event => toggleAllTargetSelections(event.target.checked)}
              />
              Select all ({selectedTargetCount}/{targetIds.length})
            </label>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={selectedTargetCount === 0}
              onClick={() => {
                setDeleteError(null);
                setDeleteState('default');
                setDeleteTargetRows(
                  (targets.data ?? []).filter(target => selectedTargetIds.has(target.id))
                );
              }}
            >
              <Trash2 className="size-4" />
              Delete selected ({selectedTargetCount})
            </Button>
          </div>
        ) : null}

        <Accordion multiple className="overflow-hidden rounded-lg border px-4">
          {targets.data.map(target => {
            const sharedWithOthers = target.activeMemberAccessCount > 1;
            return (
              <AccordionItem key={target.id} value={target.id}>
                <div className="flex items-center gap-1">
                  {canManageTargets ? (
                    <input
                      type="checkbox"
                      checked={selectedTargetIds.has(target.id)}
                      aria-label={`Select ${target.label}`}
                      className="size-4 shrink-0"
                      onClick={event => event.stopPropagation()}
                      onChange={event => toggleTargetSelection(target.id, event.target.checked)}
                    />
                  ) : null}
                  <AccordionTrigger className="flex-1 hover:no-underline">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{target.label}</span>
                      <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {target.type}
                      </span>
                      <span
                        className={
                          target.reachable
                            ? 'text-xs font-normal text-emerald-600 dark:text-emerald-400'
                            : 'text-xs font-normal text-muted-foreground'
                        }
                      >
                        {targetStatusLabel(target.status, target.reachable)}
                      </span>
                    </span>
                  </AccordionTrigger>
                  {canManageTargets ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0 text-destructive hover:text-destructive"
                      aria-label={`Delete ${target.label}`}
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteState('default');
                        setDeleteTargetRows([target]);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
                <AccordionContent className="space-y-4 pt-2">
                  {canManageTargets ? (
                    <ExecutionTargetNameEditor workspaceId={workspaceId} target={target} />
                  ) : null}
                  <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div className="space-y-1">
                      <dt className="text-xs text-muted-foreground">Owner</dt>
                      <dd>{target.ownerDisplayName ?? 'Workspace-managed target'}</dd>
                    </div>
                    <div className="space-y-1">
                      <dt className="text-xs text-muted-foreground">Access</dt>
                      <dd>
                        {target.activeMemberAccessCount} active{' '}
                        {target.activeMemberAccessCount === 1 ? 'member' : 'members'}
                        {sharedWithOthers ? ' (shared)' : ''}
                        {!target.hasCurrentUserAccess ? ' · not available to you' : ''}
                      </dd>
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <dt className="text-xs text-muted-foreground">Target ID</dt>
                      <dd className="break-all font-mono text-xs">{target.id}</dd>
                    </div>
                  </dl>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </div>

      <Dialog
        open={deleteTargetRows.length > 0}
        onOpenChange={open => {
          if (!open) {
            setDeleteTargetRows([]);
            setDeleteError(null);
            setDeleteState('default');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deleteTargetRows.length === 1 ? 'execution target' : 'execution targets'}?
            </DialogTitle>
            <DialogDescription>
              {deleteTargetRows.length
                ? deleteTargetRows.length === 1
                  ? `Remove "${deleteTargetRows[0].label}" from this workspace. Linked resources on this target will be unlinked, and project target selections pointing here will be cleared. Historical runs are kept.`
                  : `Remove ${deleteTargetRows.length} selected targets from this workspace. Linked resources on each target will be unlinked, and project target selections pointing to them will be cleared. Historical runs are kept.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {deleteError ? <p className="text-sm text-destructive">{deleteError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTargetRows([])}>
              Cancel
            </Button>
            <LoadingButton
              buttonState={deleteState}
              text={deleteTargetRows.length === 1 ? 'Delete target' : 'Delete targets'}
              loadingText="Deleting…"
              successText="Deleted"
              errorText="Delete failed"
              variant="destructive"
              onClick={() => void handleDeleteTarget()}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
