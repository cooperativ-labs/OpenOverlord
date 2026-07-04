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
import { useCreateWorkspace, useMeta } from '@/lib/queries';
import { sanitizeWorkspaceSlugInput, suggestWorkspaceSlug } from '@/lib/workspace-slug';

type WorkspaceCreatorModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function WorkspaceCreatorModal({ open, onOpenChange }: WorkspaceCreatorModalProps) {
  const navigate = useNavigate();
  const meta = useMeta();
  const createWorkspaceMutation = useCreateWorkspace();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createButtonState, setCreateButtonState] = useState<ButtonLoadingState>('default');

  const organizationId = meta.data?.organization?.id ?? null;
  const suggestedSlug = suggestWorkspaceSlug(name);
  const resolvedSlug = slugTouched ? slug : suggestedSlug;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setName('');
      setSlug('');
      setSlugTouched(false);
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
      if (!trimmedName) throw new Error('Workspace name is required.');
      if (!organizationId) throw new Error('No active organization.');

      await createWorkspaceMutation.mutateAsync({
        organizationId,
        name: trimmedName,
        slug: resolvedSlug.trim() || undefined
      });

      setCreateButtonState('success');
      handleOpenChange(false);
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
            Workspaces keep their own projects, missions, and members inside this organization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="workspace-name">Workspace name</Label>
            <Input
              id="workspace-name"
              autoFocus
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="e.g. Engineering"
              onKeyDown={event => {
                if (event.key === 'Enter') void handleCreate();
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="workspace-slug">Workspace slug</Label>
            <Input
              id="workspace-slug"
              value={resolvedSlug}
              onChange={event => {
                setSlugTouched(true);
                setSlug(sanitizeWorkspaceSlugInput(event.target.value));
              }}
              placeholder={suggestedSlug}
              className="font-mono"
            />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
