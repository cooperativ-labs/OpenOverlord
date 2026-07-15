import { useNavigate } from '@tanstack/react-router';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';

import {
  DEFAULT_PROJECT_COLOR,
  ProjectColorSetter,
  toHexColor
} from '@/components/projects/ProjectColorSetter';
import { WebProjectCliLinkStep } from '@/components/projects/WebProjectCliLinkStep';
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
import { api } from '@/lib/api';
import { getDesktopChrome } from '@/lib/desktop-chrome';
import { writeLocalProjectMetadata } from '@/lib/project-metadata';
import { useCreateProject, useLaunchSettings, useMeta } from '@/lib/queries';

type ProjectCreatorModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string;
};

type ModalPhase = 'create' | 'link-cli';

export function ProjectCreatorModal({ open, onOpenChange, workspaceId }: ProjectCreatorModalProps) {
  const navigate = useNavigate();
  const meta = useMeta();
  const createProjectMutation = useCreateProject();
  const targetWorkspaceId = workspaceId ?? meta.data?.workspace?.id;
  const launchSettingsQ = useLaunchSettings(targetWorkspaceId);
  const { isDesktop } = getDesktopChrome();
  const [phase, setPhase] = useState<ModalPhase>('create');
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(DEFAULT_PROJECT_COLOR);
  const [primaryResourcePath, setPrimaryResourcePath] = useState('');
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createButtonState, setCreateButtonState] = useState<ButtonLoadingState>('default');

  const canBrowseDirectories = isDesktop && typeof window.overlord?.chooseDirectory === 'function';
  const isLinkCliPhase = !isDesktop && phase === 'link-cli' && createdProjectId !== null;

  function resetModalState() {
    setPhase('create');
    setCreatedProjectId(null);
    setName('');
    setColor(DEFAULT_PROJECT_COLOR);
    setPrimaryResourcePath('');
    setIsBrowsing(false);
    setError(null);
    setCreateButtonState('default');
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      resetModalState();
    }
    onOpenChange(next);
  }

  function goToCreatedProject() {
    if (!createdProjectId) return;
    const projectId = createdProjectId;
    resetModalState();
    onOpenChange(false);
    void navigate({ to: '/projects/$projectId', params: { projectId } });
  }

  async function handleBrowseDirectory() {
    const chooseDirectory = window.overlord?.chooseDirectory;
    if (!chooseDirectory) return;

    setError(null);
    setIsBrowsing(true);
    try {
      const chosen = await chooseDirectory();
      if (chosen) setPrimaryResourcePath(chosen);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to choose directory.');
    } finally {
      setIsBrowsing(false);
    }
  }

  async function handleCreate() {
    setCreateButtonState('loading');
    setError(null);

    try {
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error('Project name is required.');
      }
      if (!targetWorkspaceId) {
        throw new Error('A workspace must be selected before creating a project.');
      }

      const hexColor = toHexColor(color);
      if (!hexColor) {
        throw new Error('Use a valid 6-digit hex color, like #d4d4d8.');
      }

      const trimmedPrimaryResourcePath = isDesktop ? primaryResourcePath.trim() : '';
      if (trimmedPrimaryResourcePath && launchSettingsQ.isLoading) {
        throw new Error('Launch settings are still loading. Try again in a moment.');
      }

      const created = await createProjectMutation.mutateAsync({
        name: trimmedName,
        workspaceId: targetWorkspaceId,
        color: hexColor,
        primaryResource: trimmedPrimaryResourcePath
          ? {
              directoryPath: trimmedPrimaryResourcePath,
              executionTargetId: launchSettingsQ.data?.executionTargetId ?? null
            }
          : null
      });
      if (trimmedPrimaryResourcePath) {
        const resources = await api.listProjectResources(created.id);
        const primaryResource =
          resources.find(resource => resource.path === trimmedPrimaryResourcePath) ??
          resources.find(resource => resource.isPrimary);
        if (primaryResource) {
          await writeLocalProjectMetadata({
            directoryPath: trimmedPrimaryResourcePath,
            projectId: created.id,
            resource: primaryResource
          });
        }
      }

      setCreateButtonState('success');

      if (isDesktop) {
        handleOpenChange(false);
        void navigate({ to: '/projects/$projectId', params: { projectId: created.id } });
        return;
      }

      setCreatedProjectId(created.id);
      setPhase('link-cli');
      setCreateButtonState('default');
    } catch (err) {
      setCreateButtonState('error');
      setError(err instanceof Error ? err.message : 'Failed to create project.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isLinkCliPhase ? 'Link your repository' : 'New project'}</DialogTitle>
          <DialogDescription>
            {isLinkCliPhase
              ? 'Your project was created. Use the CLI to connect a local checkout on your machine.'
              : 'Create a project to organize missions and tasks.'}
          </DialogDescription>
        </DialogHeader>

        {isLinkCliPhase ? (
          <div className="py-2">
            <WebProjectCliLinkStep projectId={createdProjectId} />
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Project name"
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleCreate();
                }}
              />
            </div>

            <div className="space-y-2">
              <Label>Color</Label>
              <ProjectColorSetter value={color} onSelect={setColor} />
            </div>

            {isDesktop ? (
              <div className="space-y-2">
                <Label htmlFor="project-primary-resource">Primary resource</Label>
                <div className="flex gap-2">
                  <Input
                    id="project-primary-resource"
                    value={primaryResourcePath}
                    onChange={e => setPrimaryResourcePath(e.target.value)}
                    placeholder="/path/to/checkout"
                    className="min-w-0 flex-1"
                  />
                  {canBrowseDirectories ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0 gap-1.5"
                      disabled={isBrowsing}
                      onClick={() => void handleBrowseDirectory()}
                    >
                      <FolderOpen className="size-4" />
                      Browse
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  Optional. If provided, this directory is linked as the project&apos;s primary
                  resource.
                </p>
              </div>
            ) : null}

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        )}

        <DialogFooter>
          {isLinkCliPhase ? (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Close
              </Button>
              <Button type="button" onClick={goToCreatedProject}>
                Go to project
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <LoadingButton
                buttonState={createButtonState}
                setButtonState={setCreateButtonState}
                text="Create project"
                loadingText="Creating…"
                successText="Created"
                onClick={handleCreate}
              />
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
