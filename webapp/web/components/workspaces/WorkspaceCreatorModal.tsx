import { useNavigate } from '@tanstack/react-router';
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
import { WorkspaceCreationFields } from '@/components/workspaces/WorkspaceCreationFields';
import { useWorkspaceCreationForm } from '@/lib/hooks/use-workspace-creation-form';
import { useCreateWorkspace } from '@/lib/queries';

type WorkspaceCreatorModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function WorkspaceCreatorModal({ open, onOpenChange }: WorkspaceCreatorModalProps) {
  const navigate = useNavigate();
  const createWorkspaceMutation = useCreateWorkspace();
  const {
    name,
    setName,
    workspaceId,
    setWorkspaceIdFromInput,
    slug,
    setSlugFromInput,
    exampleSlug,
    reset,
    getSubmitBody
  } = useWorkspaceCreationForm();
  const [error, setError] = useState<string | null>(null);
  const [createButtonState, setCreateButtonState] = useState<ButtonLoadingState>('default');

  function handleOpenChange(next: boolean) {
    if (!next) {
      reset();
      setError(null);
      setCreateButtonState('default');
    }
    onOpenChange(next);
  }

  async function handleCreate() {
    setCreateButtonState('loading');
    setError(null);

    try {
      const body = getSubmitBody();
      if (!body.name) {
        throw new Error('Workspace name is required.');
      }

      await createWorkspaceMutation.mutateAsync(body);

      setCreateButtonState('success');
      handleOpenChange(false);
      // A new workspace starts empty, so drop into its (empty) projects list.
      void navigate({ to: '/projects' });
    } catch (err) {
      setCreateButtonState('error');
      setError(err instanceof Error ? err.message : 'Failed to create workspace.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            Workspaces keep their own projects, missions, and members. You&apos;ll be switched into
            the new workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <WorkspaceCreationFields
            name={name}
            onNameChange={setName}
            workspaceId={workspaceId}
            onWorkspaceIdChange={setWorkspaceIdFromInput}
            slug={slug}
            onSlugChange={setSlugFromInput}
            exampleSlug={exampleSlug}
            nameInputId="workspace-name"
            workspaceIdInputId="workspace-id"
            slugInputId="workspace-slug"
            onEnter={() => void handleCreate()}
          />

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <LoadingButton
            buttonState={createButtonState}
            setButtonState={setCreateButtonState}
            text="Create workspace"
            loadingText="Creating…"
            successText="Created"
            onClick={handleCreate}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
