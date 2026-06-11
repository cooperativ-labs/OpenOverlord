import { useNavigate } from '@tanstack/react-router';
import { Archive } from 'lucide-react';
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
import { useUpdateProject } from '@/lib/queries';

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
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiveState, setArchiveState] = useState<ButtonLoadingState>('default');
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [unarchiveState, setUnarchiveState] = useState<ButtonLoadingState>('default');
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null);

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

  return (
    <>
      <div className="space-y-6">
        <div>
          <h2 className="text-base font-medium text-destructive">Danger zone</h2>
          <p className="text-sm text-muted-foreground">
            Archive or restore <span className="font-medium text-foreground">{projectName}</span>.
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
              Archive this project to hide it from the sidebar. Tickets are preserved and the
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
      </div>

      <Dialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Archive {projectName}?</DialogTitle>
            <DialogDescription>
              The project will be hidden from the sidebar. Tickets and objectives are preserved.
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
    </>
  );
}
