import { useNavigate } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { useDeleteWorkspace } from '@/lib/queries';

import type { WorkspaceDto } from '../../../../shared/contract.ts';

type DangerZonePageProps = {
  workspace: WorkspaceDto;
  /** Whether this is the only workspace left — the last one cannot be deleted. */
  isOnlyWorkspace: boolean;
  onOpenChange: (open: boolean) => void;
};

export function DangerZonePage({ workspace, isOnlyWorkspace, onOpenChange }: DangerZonePageProps) {
  const navigate = useNavigate();
  const deleteWorkspace = useDeleteWorkspace();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteState, setDeleteState] = useState<ButtonLoadingState>('default');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDeleteWorkspace() {
    setDeleteState('loading');
    setDeleteError(null);

    try {
      await deleteWorkspace.mutateAsync(workspace.id);
      setDeleteState('success');
      setConfirmOpen(false);
      onOpenChange(false);
      // Project routes from the deleted workspace no longer resolve; land on
      // the projects list of whichever workspace is active now.
      void navigate({ to: '/projects' });
    } catch (error) {
      setDeleteState('error');
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete workspace.');
    }
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <h2 className="text-base font-medium text-destructive">Danger zone</h2>
          <p className="text-sm text-muted-foreground">
            Delete <span className="font-medium text-foreground">{workspace.name}</span>.
          </p>
        </div>

        <div className="grid gap-2">
          <p className="text-sm text-muted-foreground">
            Deleting a workspace removes it — and access to all of its projects and tickets — from
            the web interface. If it is the active workspace, the oldest remaining workspace becomes
            active.
          </p>
          {isOnlyWorkspace ? (
            <p className="text-xs text-muted-foreground">
              This is your only workspace, so it cannot be deleted. Create another workspace first.
            </p>
          ) : null}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-fit gap-1.5"
            disabled={isOnlyWorkspace}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete workspace
          </Button>
          {deleteError ? <p className="text-xs text-destructive">{deleteError}</p> : null}
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {workspace.name}?</DialogTitle>
            <DialogDescription>
              The workspace and all of its projects and tickets will no longer be reachable from the
              web interface. This cannot be undone from the UI.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <LoadingButton
              buttonState={deleteState}
              setButtonState={setDeleteState}
              text="Delete workspace"
              loadingText="Deleting…"
              errorText="Retry"
              variant="destructive"
              onClick={() => void handleDeleteWorkspace()}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
