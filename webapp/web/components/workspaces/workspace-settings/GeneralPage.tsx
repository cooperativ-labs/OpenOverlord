import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AuthenticatedAvatarImage, Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ImageDropzone } from '@/components/ui/image-dropzone';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useMeta, useProfile, useUpdateWorkspace, useUploadWorkspaceLogo } from '@/lib/queries';
import { cn } from '@/lib/utils';

import type { WorkspaceDto } from '../../../../shared/contract.ts';

type GeneralPageProps = {
  open: boolean;
  workspace: WorkspaceDto;
};

export function GeneralPage({ open, workspace }: GeneralPageProps) {
  const updateWorkspace = useUpdateWorkspace();
  const profile = useProfile();
  const meta = useMeta();
  const isAdmin = (profile.data?.roles ?? []).includes('ADMIN');
  const [name, setName] = useState(workspace.name);
  const [savedName, setSavedName] = useState(workspace.name);
  const [nameSaveState, setNameSaveState] = useState<ButtonLoadingState>('default');
  const [nameError, setNameError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sqlStudioEnabled, setSqlStudioEnabled] = useState(workspace.sqlStudioEnabled);
  const [sqlStudioError, setSqlStudioError] = useState<string | null>(null);
  const [sqlStudioPending, setSqlStudioPending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(workspace.name);
    setSavedName(workspace.name);
    setNameSaveState('default');
    setNameError(null);
    setCopied(false);
    setSqlStudioEnabled(workspace.sqlStudioEnabled);
    setSqlStudioError(null);
    setSqlStudioPending(false);
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

  async function handleSqlStudioToggle(next: boolean) {
    setSqlStudioPending(true);
    setSqlStudioError(null);
    const previous = sqlStudioEnabled;
    setSqlStudioEnabled(next);

    try {
      await updateWorkspace.mutateAsync({
        id: workspace.id,
        body: { sqlStudioEnabled: next }
      });
    } catch (error) {
      setSqlStudioEnabled(previous);
      setSqlStudioError(error instanceof Error ? error.message : 'Failed to update SQL Studio.');
    } finally {
      setSqlStudioPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">General</h2>
        <p className="text-sm text-muted-foreground">Workspace name and identifiers.</p>
      </div>

      {isAdmin ? <WorkspaceLogoUploader workspace={workspace} /> : null}

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

      {isAdmin ? (
        <>
          <Separator />
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-medium">SQL Studio</h3>
              <p className="text-sm text-muted-foreground">
                Launch a local database browser for this workspace&apos;s SQLite database.
              </p>
            </div>
            <div className="flex max-w-lg items-center justify-between gap-4 rounded-lg border p-4">
              <div className="space-y-1">
                <Label htmlFor="workspace-sql-studio-toggle">Enable SQL Studio</Label>
                <p className="text-xs text-muted-foreground">
                  Requires the <code className="font-mono">sql-studio</code> binary on the server
                  host. Keep disabled on shared or production instances.
                </p>
                {meta.data?.sqlStudio.url ? (
                  <p className="text-xs text-muted-foreground">
                    Running at{' '}
                    <a
                      href={meta.data.sqlStudio.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono underline-offset-4 hover:underline"
                    >
                      {meta.data.sqlStudio.url}
                    </a>
                  </p>
                ) : null}
              </div>
              <Switch
                id="workspace-sql-studio-toggle"
                checked={sqlStudioEnabled}
                disabled={sqlStudioPending}
                onCheckedChange={next => void handleSqlStudioToggle(next)}
              />
            </div>
            {sqlStudioError ? <p className="text-xs text-destructive">{sqlStudioError}</p> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Derive up-to-two-letter initials for the logo fallback. */
function initialsFor(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('');
  return initials || 'OL';
}

/**
 * The logo shown in workspace settings, doubling as the drop target for the
 * core upload service. Dropping (or clicking to browse and selecting) an image
 * uploads it to the `workspace-images` bucket and sets it as the workspace's
 * logo. Admin-only (gated by the caller); the server also enforces this.
 */
function WorkspaceLogoUploader({ workspace }: { workspace: WorkspaceDto }) {
  const uploadLogo = useUploadWorkspaceLogo();
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(file: File) {
    setError(null);
    try {
      await uploadLogo.mutateAsync({ workspaceId: workspace.id, file });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload image.');
    }
  }

  return (
    <div className="flex items-center gap-4">
      <ImageDropzone
        onSelect={handleSelect}
        onError={setError}
        disabled={uploadLogo.isPending}
        label="Upload a workspace logo"
      >
        <Avatar size="lg" className="size-12">
          {workspace.logoUrl ? (
            <AuthenticatedAvatarImage src={workspace.logoUrl} alt={workspace.name} />
          ) : null}
          <AvatarFallback className="rounded-full">{initialsFor(workspace.name)}</AvatarFallback>
        </Avatar>
      </ImageDropzone>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{workspace.name}</p>
        <p className={cn('truncate text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
          {uploadLogo.isPending
            ? 'Uploading…'
            : (error ?? 'Drag an image or click to upload a workspace logo.')}
        </p>
      </div>
    </div>
  );
}
