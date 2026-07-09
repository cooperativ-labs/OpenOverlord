import { AlertTriangle, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useProjectRepositoryContext } from '@/components/projects/ProjectRepositoryContext.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';
import { writeLocalProjectMetadata } from '@/lib/project-metadata';
import {
  useCreateProjectResource,
  useDeleteProjectResource,
  useLaunchSettings,
  useProject,
  useProjectResources,
  useUpdateProject,
  useUpdateProjectExecutionTarget,
  useUpdateProjectResource
} from '@/lib/queries';

import type {
  EligibleExecutionTargetDto,
  ProjectResourceDto
} from '../../../../shared/contract.ts';

type ResourcesPageProps = {
  open: boolean;
  projectId: string;
};

function resourceStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Linked';
    case 'missing':
      return 'Missing';
    case 'archived':
      return 'Archived';
    default:
      return status;
  }
}

const ANY_TARGET_VALUE = '__any_target__';

function targetOptionLabel(target: EligibleExecutionTargetDto): string {
  const device = target.deviceLabel?.trim();
  const base = target.label.trim() || target.executionTargetId;
  return device && device !== base ? `${base} (${device})` : base;
}

function ResourcePathCell({ path, targetLabel }: { path: string; targetLabel: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <td className="max-w-xs px-3 py-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex w-full min-w-0 cursor-pointer flex-col gap-1 text-left font-mono text-xs hover:opacity-80"
              onClick={() => void copy(path)}
              aria-label={`Copy path ${path}`}
            >
              <span className="block truncate" dir="rtl">
                {path}
              </span>
              <span className="text-xs text-muted-foreground">{targetLabel}</span>
            </button>
          }
        />
        <TooltipContent side="top" className="max-w-md break-all font-mono">
          {copied ? 'Copied to clipboard' : path}
        </TooltipContent>
      </Tooltip>
    </td>
  );
}

export function ResourcesPage({ open, projectId }: ResourcesPageProps) {
  const { eligibleTargets, selectedExecutionTargetId } = useProjectRepositoryContext();
  const updateExecutionTarget = useUpdateProjectExecutionTarget(projectId);
  const resourcesQ = useProjectResources(projectId);
  const launchSettingsQ = useLaunchSettings();
  const projectQ = useProject(projectId);
  const updateProject = useUpdateProject(projectId);
  const createResource = useCreateProjectResource(projectId);
  const updateResource = useUpdateProjectResource(projectId);
  const deleteResource = useDeleteProjectResource(projectId);

  const rows = open ? (resourcesQ.data ?? []) : [];
  const localExecutionTargetId = launchSettingsQ.data?.executionTargetId ?? null;
  const deviceLabel = launchSettingsQ.data?.deviceLabel ?? 'This device';
  const activeExecutionTargetId = selectedExecutionTargetId ?? localExecutionTargetId;
  const activeTarget = eligibleTargets.find(
    target => target.executionTargetId === activeExecutionTargetId
  );
  const addTargetLabel = activeTarget ? targetOptionLabel(activeTarget) : deviceLabel;
  const hasMissingPrimary = rows.some(
    resource => resource.isPrimary && resource.status === 'missing'
  );
  const hasLocalPrimary =
    activeExecutionTargetId !== null &&
    rows.some(
      resource => resource.executionTargetId === activeExecutionTargetId && resource.isPrimary
    );

  const [targetError, setTargetError] = useState<string | null>(null);
  const canBrowseDirectories =
    typeof window !== 'undefined' && typeof window.overlord?.chooseDirectory === 'function';

  const [directoryPath, setDirectoryPath] = useState('');
  const [resourceKeyInput, setResourceKeyInput] = useState('');
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [resourceKeyEdits, setResourceKeyEdits] = useState<Record<string, string>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectResourceDto | null>(null);

  useEffect(() => {
    const resources = open ? (resourcesQ.data ?? []) : [];
    setResourceKeyEdits(previous => {
      const next: Record<string, string> = {};
      for (const resource of resources) {
        next[resource.id] = previous[resource.id] ?? resource.resourceKey;
      }
      return next;
    });
  }, [open, resourcesQ.data]);

  // Project default/parent branch (stored in project settings). The input mirrors
  // the saved value; an empty value clears the setting (falls back to `main`).
  const savedDefaultBranch = projectQ.data?.defaultBranch ?? '';
  const [defaultBranchInput, setDefaultBranchInput] = useState(savedDefaultBranch);
  const [defaultBranchError, setDefaultBranchError] = useState<string | null>(null);
  const [defaultBranchSaved, setDefaultBranchSaved] = useState(false);
  useEffect(() => {
    setDefaultBranchInput(savedDefaultBranch);
  }, [savedDefaultBranch]);
  const defaultBranchDirty = defaultBranchInput.trim() !== savedDefaultBranch;

  async function handleSaveDefaultBranch() {
    if (!defaultBranchDirty) return;
    setDefaultBranchError(null);
    setDefaultBranchSaved(false);
    try {
      await updateProject.mutateAsync({ defaultBranch: defaultBranchInput.trim() || null });
      setDefaultBranchSaved(true);
    } catch (error) {
      setDefaultBranchError(
        error instanceof Error ? error.message : 'Failed to save default branch.'
      );
    }
  }

  function targetLabel(resource: ProjectResourceDto): string {
    if (resource.executionTargetId === null) return 'Any target';
    const match = eligibleTargets.find(
      target => target.executionTargetId === resource.executionTargetId
    );
    if (match) return targetOptionLabel(match);
    if (resource.executionTargetId === localExecutionTargetId) {
      return `${deviceLabel} (this device)`;
    }
    return resource.executionTargetId;
  }

  function handleExecutionTargetChange(value: string | null) {
    setTargetError(null);
    updateExecutionTarget.mutate(
      { executionTargetId: !value || value === ANY_TARGET_VALUE ? null : value },
      {
        onError: error => {
          setTargetError(
            error instanceof Error ? error.message : 'Failed to update execution target.'
          );
        }
      }
    );
  }

  const selectorValue =
    selectedExecutionTargetId ??
    (eligibleTargets.length > 1 ? ANY_TARGET_VALUE : (eligibleTargets[0]?.executionTargetId ?? ''));
  async function handleBrowseDirectory() {
    const chooseDirectory = window.overlord?.chooseDirectory;
    if (!chooseDirectory) return;

    setAddError(null);
    setIsBrowsing(true);
    try {
      const chosen = await chooseDirectory();
      if (chosen) setDirectoryPath(chosen);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Failed to choose directory.');
    } finally {
      setIsBrowsing(false);
    }
  }

  async function handleAddResource() {
    const trimmed = directoryPath.trim();
    if (!trimmed) {
      setAddError('Enter a directory path.');
      return;
    }

    setAddError(null);
    try {
      const resource = await createResource.mutateAsync({
        directoryPath: trimmed,
        resourceKey: resourceKeyInput.trim() || undefined,
        executionTargetId: activeExecutionTargetId,
        isPrimary: !hasLocalPrimary
      });
      await writeLocalProjectMetadata({ directoryPath: trimmed, projectId, resource });
      setDirectoryPath('');
      setResourceKeyInput('');
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Failed to add directory.');
    }
  }

  async function handleSaveResourceKey(resource: ProjectResourceDto) {
    const nextKey = resourceKeyEdits[resource.id]?.trim() ?? '';
    if (!nextKey || nextKey === resource.resourceKey) return;
    setRowError(null);
    try {
      await updateResource.mutateAsync({
        resourceId: resource.id,
        body: { resourceKey: nextKey }
      });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to update resource key.');
    }
  }

  async function handleSetPrimary(resource: ProjectResourceDto) {
    if (resource.isPrimary) return;
    setRowError(null);
    try {
      await updateResource.mutateAsync({ resourceId: resource.id, body: { isPrimary: true } });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to update primary resource.');
    }
  }

  async function handleDeleteResource() {
    if (!deleteTarget) return;
    setDeleteError(null);
    try {
      await deleteResource.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Failed to remove directory.');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Resource directories</h2>
        <p className="text-sm text-muted-foreground">
          Choose where agents run for this project, then manage working directories per execution
          target.
        </p>
      </div>

      {eligibleTargets.length > 0 ? (
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium">Execution target</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Runs queue on the selected device. When several targets are eligible and none is chosen,
            any online target with a connected primary may claim the work.
          </p>
          <div className="mt-3 grid max-w-md gap-1.5">
            <Label htmlFor="project-execution-target">Run agents on</Label>
            <Select value={selectorValue} onValueChange={handleExecutionTargetChange}>
              <SelectTrigger id="project-execution-target" className="h-8">
                <SelectValue placeholder="Select execution target" />
              </SelectTrigger>
              <SelectContent>
                {eligibleTargets.length > 1 ? (
                  <SelectItem value={ANY_TARGET_VALUE}>Any eligible target</SelectItem>
                ) : null}
                {eligibleTargets.map(target => (
                  <SelectItem
                    key={target.executionTargetId}
                    value={target.executionTargetId}
                    disabled={!target.reachable || !target.primaryResourceConnected}
                  >
                    {targetOptionLabel(target)}
                    {!target.reachable ? ' (offline)' : ''}
                    {target.reachable && !target.primaryResourceConnected ? ' (no primary)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {targetError ? <p className="text-xs text-destructive">{targetError}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-medium">Default branch</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The base branch new mission branches are cut from and the parent that{' '}
          <span className="font-medium">Merge with parent</span> advances. Leave blank to use the
          repository default (<code className="text-xs">main</code>).
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Label htmlFor="project-default-branch">Branch name</Label>
            <Input
              id="project-default-branch"
              value={defaultBranchInput}
              onChange={event => {
                setDefaultBranchInput(event.target.value);
                setDefaultBranchSaved(false);
                setDefaultBranchError(null);
              }}
              placeholder="main"
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              disabled={projectQ.isLoading}
              onKeyDown={event => {
                if (event.key === 'Enter') void handleSaveDefaultBranch();
              }}
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={!defaultBranchDirty || updateProject.isPending}
            onClick={() => void handleSaveDefaultBranch()}
          >
            Save
          </Button>
        </div>
        {defaultBranchError ? (
          <p className="mt-2 text-xs text-destructive">{defaultBranchError}</p>
        ) : defaultBranchSaved && !defaultBranchDirty ? (
          <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">Saved.</p>
        ) : null}
      </div>

      {hasMissingPrimary ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            A primary working directory is missing. Set another directory as primary before
            launching agents from this project.
          </p>
        </div>
      ) : null}

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-medium">Add directory</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          New directories are linked to <span className="font-medium">{addTargetLabel}</span>.
        </p>
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem_auto] lg:items-end">
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Label htmlFor="resource-directory-path">Directory path</Label>
            <div className="flex gap-2">
              <Input
                id="resource-directory-path"
                value={directoryPath}
                onChange={event => setDirectoryPath(event.target.value)}
                placeholder="/path/to/checkout"
                className="h-8 min-w-0 flex-1"
                onKeyDown={event => {
                  if (event.key === 'Enter') void handleAddResource();
                }}
              />
              {canBrowseDirectories ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5"
                  disabled={isBrowsing}
                  onClick={() => void handleBrowseDirectory()}
                >
                  <FolderOpen className="size-3.5" />
                  Browse
                </Button>
              ) : null}
            </div>
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="resource-key">Resource key</Label>
            <Input
              id="resource-key"
              value={resourceKeyInput}
              onChange={event => setResourceKeyInput(event.target.value)}
              placeholder="derived from directory"
              className="h-8 min-w-0 font-mono text-xs"
              onKeyDown={event => {
                if (event.key === 'Enter') void handleAddResource();
              }}
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            disabled={createResource.isPending || launchSettingsQ.isLoading}
            onClick={() => void handleAddResource()}
          >
            <Plus className="size-3.5" />
            Add directory
          </Button>
        </div>
        {addError ? <p className="mt-2 text-xs text-destructive">{addError}</p> : null}
      </div>

      {resourcesQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading resources…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No directories linked yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Key</th>
                <th className="px-3 py-2 font-medium">Path</th>
                <th className="px-3 py-2 font-medium">Primary</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map(resource => (
                <tr key={resource.id} className="border-t">
                  <td className="min-w-44 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Input
                        value={resourceKeyEdits[resource.id] ?? resource.resourceKey}
                        onChange={event =>
                          setResourceKeyEdits(previous => ({
                            ...previous,
                            [resource.id]: event.target.value
                          }))
                        }
                        onKeyDown={event => {
                          if (event.key === 'Enter') void handleSaveResourceKey(resource);
                        }}
                        className="h-7 min-w-0 font-mono text-xs"
                        aria-label={`Resource key for ${resource.path}`}
                      />
                      {(resourceKeyEdits[resource.id] ?? resource.resourceKey).trim() !==
                      resource.resourceKey ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7"
                          disabled={updateResource.isPending}
                          onClick={() => void handleSaveResourceKey(resource)}
                        >
                          Save
                        </Button>
                      ) : null}
                    </div>
                  </td>
                  <ResourcePathCell path={resource.path} targetLabel={targetLabel(resource)} />
                  <td className="px-3 py-2">
                    {resource.isPrimary ? (
                      <Badge variant="secondary">Primary</Badge>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        disabled={updateResource.isPending}
                        onClick={() => void handleSetPrimary(resource)}
                      >
                        Make primary
                      </Button>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={resource.status === 'missing' ? 'destructive' : 'secondary'}>
                      {resourceStatusLabel(resource.status)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive hover:text-destructive"
                      onClick={() => {
                        setDeleteError(null);
                        setDeleteTarget(resource);
                      }}
                      aria-label={`Remove ${resource.path}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rowError ? <p className="text-xs text-destructive">{rowError}</p> : null}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={nextOpen => {
          if (!nextOpen) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove directory</DialogTitle>
            <DialogDescription>
              Remove &ldquo;{deleteTarget?.path}&rdquo; from this project?
            </DialogDescription>
          </DialogHeader>
          {deleteError ? <p className="text-sm text-destructive">{deleteError}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteResource.isPending}
              onClick={() => void handleDeleteResource()}
            >
              Remove directory
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
