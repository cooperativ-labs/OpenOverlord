import { useNavigate } from '@tanstack/react-router';
import { Archive, Trash2 } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { useDeleteProject, useUpdateProject } from '@/lib/queries';

type DangerZonePageProps = {
  projectId: string;
  projectName: string;
  isArchived?: boolean;
  onOpenChange: (open: boolean) => void;
};

export function DangerZonePage({
  projectId,
  projectName,
  isArchived = false,
  onOpenChange
}: DangerZonePageProps) {
  const navigate = useNavigate();
  const updateProject = useUpdateProject(projectId);
  const deleteProject = useDeleteProject();
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiveState, setArchiveState] = useState<ButtonLoadingState>('default');
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [unarchiveState, setUnarchiveState] = useState<ButtonLoadingState>('default');
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteNameInput, setDeleteNameInput] = useState('');
  const [deleteState, setDeleteState] = useState<ButtonLoadingState>('default');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleArchiveProject() {
    setArchiveState('loading');
    setArchiveError(null);

    try {
      await updateProject.mutateAsync({ status: 'archived' });
      setArchiveState('success');
      setArchiveConfirmOpen(false);
      onOpenChange(false);
      void navigate({ to: '/projects' });
    } catch (error) {
      setArchiveState('error');
      setArchiveError(error instanceof Error ? error.message : 'Failed to archive project.');
    }
  }

  async function handleUnarchiveProject() {
    setUnarchiveState('loading');
    setUnarchiveError(null);

    try {
      await updateProject.mutateAsync({ status: 'active' });
      setUnarchiveState('success');
      onOpenChange(false);
    } catch (error) {
      setUnarchiveState('error');
      setUnarchiveError(error instanceof Error ? error.message : 'Failed to unarchive project.');
    }
  }

  async function handleDeleteProject() {
    setDeleteState('loading');
    setDeleteError(null);

    try {
      await deleteProject.mutateAsync(projectId);
      setDeleteState('success');
      setDeleteConfirmOpen(false);
      onOpenChange(false);
      void navigate({ to: '/projects' });
    } catch (error) {
      setDeleteState('error');
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete project.');
    }
  }

  function handleOpenDeleteDialog() {
    setDeleteNameInput('');
    setDeleteState('default');
    setDeleteError(null);
    setDeleteConfirmOpen(true);
  }

  return (
    <>
      <div className="space-y-6">
        <div>
          <h2 className="text-base font-medium text-destructive">Danger zone</h2>
          <p className="text-sm text-muted-foreground">
            Archive or delete <span className="font-medium text-foreground">{projectName}</span>.
          </p>
        </div>

        {isArchived ? (
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">
              This project is archived. Unarchive it to restore it to the sidebar and project
              selectors.
            </p>
            <LoadingButton
              buttonState={unarchiveState}
              setButtonState={setUnarchiveState}
              text="Unarchive project"
              loadingText="Unarchiving…"
              successText="Unarchived"
              errorText="Retry"
              reset
              type="button"
              variant="outline"
              size="sm"
              className="w-fit gap-1.5"
              onClick={handleUnarchiveProject}
            />
            {unarchiveError ? <p className="text-xs text-destructive">{unarchiveError}</p> : null}
          </div>
        ) : (
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">
              Archive this project to hide it from the sidebar. Missions are preserved and the
              project can be unarchived later.
            </p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="w-fit gap-1.5"
              onClick={() => setArchiveConfirmOpen(true)}
            >
              <Archive className="h-3.5 w-3.5" />
              Archive project
            </Button>
            {archiveError ? <p className="text-xs text-destructive">{archiveError}</p> : null}
          </div>
        )}

        <div className="grid gap-2 border-t pt-6">
          <p className="text-sm font-medium">Delete project</p>
          <p className="text-sm text-muted-foreground">
            Permanently delete this project and all of its missions. This cannot be undone.
          </p>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-fit gap-1.5"
            onClick={handleOpenDeleteDialog}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete project
          </Button>
          {deleteError ? <p className="text-xs text-destructive">{deleteError}</p> : null}
        </div>
      </div>

      <Dialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Archive {projectName}?</DialogTitle>
            <DialogDescription>
              The project will be hidden from the sidebar. Missions and objectives are preserved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setArchiveConfirmOpen(false)}>
              Cancel
            </Button>
            <LoadingButton
              buttonState={archiveState}
              setButtonState={setArchiveState}
              text="Archive"
              loadingText="Archiving…"
              successText="Archived"
              errorText="Retry"
              variant="destructive"
              onClick={handleArchiveProject}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {projectName}?</DialogTitle>
            <DialogDescription>
              All missions and objectives in this project will be permanently deleted. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-2">
            <p className="text-sm text-muted-foreground">
              Type <span className="font-mono font-medium text-foreground">{projectName}</span> to
              confirm.
            </p>
            <Input
              value={deleteNameInput}
              onChange={e => setDeleteNameInput(e.target.value)}
              placeholder={projectName}
              className="h-8"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              Cancel
            </Button>
            <LoadingButton
              buttonState={deleteState}
              setButtonState={setDeleteState}
              text="Delete project"
              loadingText="Deleting…"
              errorText="Retry"
              variant="destructive"
              disabled={deleteNameInput !== projectName}
              onClick={() => void handleDeleteProject()}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
