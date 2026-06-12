import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { useUpdateWorkspace } from '@/lib/queries';

import type { WorkspaceDto } from '../../../../shared/contract.ts';

type GeneralPageProps = {
  open: boolean;
  workspace: WorkspaceDto;
};

export function GeneralPage({ open, workspace }: GeneralPageProps) {
  const updateWorkspace = useUpdateWorkspace();
  const [name, setName] = useState(workspace.name);
  const [savedName, setSavedName] = useState(workspace.name);
  const [nameSaveState, setNameSaveState] = useState<ButtonLoadingState>('default');
  const [nameError, setNameError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(workspace.name);
    setSavedName(workspace.name);
    setNameSaveState('default');
    setNameError(null);
    setCopied(false);
  }, [open, workspace]);

  async function handleSaveName() {
    const trimmed = name.trim();
    if (trimmed === savedName || !trimmed) return;

    setNameSaveState('loading');
    setNameError(null);

    try {
      await updateWorkspace.mutateAsync({ id: workspace.id, body: { name: trimmed } });
      setSavedName(trimmed);
      setName(trimmed);
      setNameSaveState('success');
    } catch (error) {
      setNameSaveState('error');
      setNameError(error instanceof Error ? error.message : 'Failed to update name.');
    }
  }

  async function handleCopyWorkspaceId() {
    try {
      await navigator.clipboard.writeText(workspace.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">General</h2>
        <p className="text-sm text-muted-foreground">Workspace name and identifiers.</p>
      </div>

      <div className="grid max-w-lg gap-2">
        <Label htmlFor="workspace-settings-name">Name</Label>
        <div className="flex gap-2">
          <Input
            id="workspace-settings-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Workspace name"
            className="h-8"
            onBlur={handleSaveName}
            onKeyDown={e => {
              if (e.key === 'Enter') void handleSaveName();
            }}
            disabled={nameSaveState === 'loading'}
          />
          <LoadingButton
            buttonState={nameSaveState}
            setButtonState={setNameSaveState}
            text="Save"
            loadingText="Saving…"
            successText="Saved"
            errorText="Retry"
            reset
            size="sm"
            variant="outline"
            className="h-8 shrink-0"
            onClick={handleSaveName}
          />
        </div>
        {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
      </div>

      <div className="grid max-w-lg gap-2">
        <Label>Slug</Label>
        <Input value={workspace.slug} readOnly className="h-8 font-mono text-xs" />
        <p className="text-xs text-muted-foreground">
          Stable human-readable key. Set when the workspace is created.
        </p>
      </div>

      <div className="grid max-w-lg gap-2">
        <Label>Workspace ID</Label>
        <div className="flex items-center gap-2">
          <Input value={workspace.id} readOnly className="h-8 font-mono text-xs" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 gap-1.5"
            onClick={handleCopyWorkspaceId}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Stable identifier used by the CLI and protocol surfaces.
        </p>
      </div>
    </div>
  );
}
