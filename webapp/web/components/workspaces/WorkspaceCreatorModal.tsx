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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { useCreateWorkspace } from '@/lib/queries';

type WorkspaceCreatorModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function WorkspaceCreatorModal({ open, onOpenChange }: WorkspaceCreatorModalProps) {
  const navigate = useNavigate();
  const createWorkspaceMutation = useCreateWorkspace();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createButtonState, setCreateButtonState] = useState<ButtonLoadingState>('default');

  function handleOpenChange(next: boolean) {
    if (!next) {
      setName('');
      setError(null);
      setCreateButtonState('default');
    }
    onOpenChange(next);
  }

  async function handleCreate() {
    setCreateButtonState('loading');
    setError(null);

    try {
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error('Workspace name is required.');
      }

      await createWorkspaceMutation.mutateAsync({ name: trimmedName });

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
            Workspaces keep their own projects, tickets, and members. You&apos;ll be switched into
            the new workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Workspace name"
              onKeyDown={e => {
                if (e.key === 'Enter') void handleCreate();
              }}
            />
          </div>

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
