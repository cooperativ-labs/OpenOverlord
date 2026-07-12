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
import { LoadingButton, type ButtonLoadingState } from '@/components/ui/loading-button';
import {
  useDeleteWorkspaceExecutionTarget,
  useWorkspaceExecutionTargets,
  useWorkspaceMembers
} from '@/lib/queries';

import type { WorkspaceExecutionTargetDto } from '../../../../shared/contract.ts';

function targetStatusLabel(status: string, reachable: boolean): string {
  if (status !== 'active') return status;
  return reachable ? 'online' : 'offline';
}

export function ExecutionTargetsPage({ workspaceId }: { workspaceId: string }) {
  const targets = useWorkspaceExecutionTargets(workspaceId);
  const members = useWorkspaceMembers(workspaceId);
  const deleteTarget = useDeleteWorkspaceExecutionTarget(workspaceId);
  const operator = (members.data ?? []).find(member => member.isOperator);
  const canManageTargets = operator?.isAdmin ?? false;

  const [deleteTargetRow, setDeleteTargetRow] = useState<WorkspaceExecutionTargetDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteState, setDeleteState] = useState<ButtonLoadingState>('default');

  async function handleDeleteTarget() {
    if (!deleteTargetRow) return;

    setDeleteState('loading');
    setDeleteError(null);
    try {
      await deleteTarget.mutateAsync(deleteTargetRow.id);
      setDeleteState('success');
      setDeleteTargetRow(null);
      setTimeout(() => setDeleteState('default'), 1200);
    } catch (error) {
      setDeleteState('error');
      setDeleteError(
        error instanceof Error ? error.message : 'Failed to delete execution target.'
      );
    }
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

        <Accordion multiple className="overflow-hidden rounded-lg border px-4">
          {targets.data.map(target => {
            const sharedWithOthers = target.activeMemberAccessCount > 1;
            return (
              <AccordionItem key={target.id} value={target.id}>
                <div className="flex items-center gap-1">
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
                        setDeleteTargetRow(target);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
                <AccordionContent className="pt-2">
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
        open={deleteTargetRow !== null}
        onOpenChange={open => {
          if (!open) {
            setDeleteTargetRow(null);
            setDeleteError(null);
            setDeleteState('default');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete execution target?</DialogTitle>
            <DialogDescription>
              {deleteTargetRow
                ? `Remove "${deleteTargetRow.label}" from this workspace. Linked resources on this target will be unlinked, and project target selections pointing here will be cleared. Historical runs are kept.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {deleteError ? <p className="text-sm text-destructive">{deleteError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTargetRow(null)}>
              Cancel
            </Button>
            <LoadingButton
              buttonState={deleteState}
              text="Delete target"
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
