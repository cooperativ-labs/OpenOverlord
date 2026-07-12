import { AlertTriangle, FolderOpen, GitBranch, HardDrive, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useProjectRepositoryContext } from '@/components/projects/ProjectRepositoryContext.tsx';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ANY_ELIGIBLE_EXECUTION_TARGET_VALUE,
  executionTargetOptionLabel,
  executionTargetOptionStatusSuffix,
  executionTargetSelectorDisplayLabel,
  parseExecutionTargetSelectorValue,
  resolveExecutionTargetSelectorValue
} from '@/lib/execution-target-selection';
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
import { cn } from '@/lib/utils';

import type {
  EligibleExecutionTargetDto,
  ProjectResourceDto,
  ProjectResourceSourceDto
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

function sourceKindLabel(sourceKind: string): string {
  switch (sourceKind) {
    case 'local_checkout':
      return 'Local';
    case 'git':
      return 'Git';
    default:
      return sourceKind;
  }
}

function sourceDescriptorValue(source: ProjectResourceSourceDto): string {
  if (source.sourceKind === 'local_checkout') {
    const path = source.descriptor.path;
    return typeof path === 'string' ? path : '';
  }
  if (source.sourceKind === 'git') {
    const url = source.descriptor.url;
    return typeof url === 'string' ? url : '';
  }
  return '';
}

function targetLabelForId({
  executionTargetId,
  eligibleTargets,
  localExecutionTargetId,
  deviceLabel
}: {
  executionTargetId: string | null;
  eligibleTargets: EligibleExecutionTargetDto[];
  localExecutionTargetId: string | null;
  deviceLabel: string;
}): string {
  if (executionTargetId === null) return 'Any target';
  const match = eligibleTargets.find(target => target.executionTargetId === executionTargetId);
  if (match) return executionTargetOptionLabel(match);
  if (executionTargetId === localExecutionTargetId) {
    return `${deviceLabel} (this device)`;
  }
  return executionTargetId;
}

function SourceRow({ source, label }: { source: ProjectResourceSourceDto; label: string }) {
  const { copied, copy } = useCopyToClipboard();
  const value = sourceDescriptorValue(source);
  return (
    <li className="min-w-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex w-full min-w-0 cursor-pointer flex-col gap-1 rounded-md border px-3 py-2 text-left hover:bg-muted/40"
              onClick={() => {
                if (value) void copy(value);
              }}
              aria-label={value ? `Copy ${value}` : `Source ${sourceKindLabel(source.sourceKind)}`}
              disabled={!value}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Badge variant="outline" className="shrink-0 font-normal">
                  {sourceKindLabel(source.sourceKind)}
                </Badge>
                {value ? (
                  <span className="block min-w-0 truncate font-mono text-xs" dir="rtl">
                    {value}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">No descriptor</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{label}</span>
            </button>
          }
        />
        <TooltipContent side="top" className="max-w-md break-all font-mono">
          {copied ? 'Copied to clipboard' : value || sourceKindLabel(source.sourceKind)}
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

type AddSourceKind = 'local_checkout' | 'git';

function AddSourceForm({
  projectId,
  resource,
  eligibleTargets,
  defaultTargetValue,
  onAdded
}: {
  projectId: string;
  resource: ProjectResourceDto;
  eligibleTargets: EligibleExecutionTargetDto[];
  defaultTargetValue: string;
  onAdded: () => void;
}) {
  const createResource = useCreateProjectResource(projectId);
  const [sourceKind, setSourceKind] = useState<AddSourceKind>('local_checkout');
  const [directoryPath, setDirectoryPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [targetValue, setTargetValue] = useState(defaultTargetValue);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canBrowseDirectories =
    typeof window !== 'undefined' && typeof window.overlord?.chooseDirectory === 'function';

  useEffect(() => {
    setTargetValue(defaultTargetValue);
  }, [defaultTargetValue]);

  async function handleBrowseDirectory() {
    const chooseDirectory = window.overlord?.chooseDirectory;
    if (!chooseDirectory) return;
    setError(null);
    setIsBrowsing(true);
    try {
      const chosen = await chooseDirectory();
      if (chosen) setDirectoryPath(chosen);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to choose directory.');
    } finally {
      setIsBrowsing(false);
    }
  }

  async function handleAddSource() {
    if (sourceKind === 'git') {
      const trimmedUrl = repoUrl.trim();
      if (!trimmedUrl) {
        setError('Enter a repository URL.');
        return;
      }
      setError(null);
      try {
        // Git sources are project-global; they are not scoped to an execution target.
        await createResource.mutateAsync({
          sourceUrl: trimmedUrl,
          resourceKey: resource.resourceKey,
          isPrimary: resource.isPrimary
        });
        setRepoUrl('');
        onAdded();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add source.');
      }
      return;
    }

    const trimmed = directoryPath.trim();
    if (!trimmed) {
      setError('Enter a directory path.');
      return;
    }
    setError(null);
    try {
      const executionTargetId = parseExecutionTargetSelectorValue(targetValue);
      const created = await createResource.mutateAsync({
        directoryPath: trimmed,
        resourceKey: resource.resourceKey,
        executionTargetId,
        isPrimary: resource.isPrimary
      });
      await writeLocalProjectMetadata({ directoryPath: trimmed, projectId, resource: created });
      setDirectoryPath('');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add source.');
    }
  }

  const kindOptions: { value: AddSourceKind; label: string; icon: typeof HardDrive }[] = [
    { value: 'local_checkout', label: 'Local path', icon: HardDrive },
    { value: 'git', label: 'Repo URL', icon: GitBranch }
  ];

  return (
    <div className="rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">Add source</h4>
        <div
          role="radiogroup"
          aria-label="Source type"
          className="inline-flex rounded-md border p-0.5"
        >
          {kindOptions.map(option => {
            const Icon = option.icon;
            const active = sourceKind === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  setSourceKind(option.value);
                  setError(null);
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="size-3.5" />
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      {sourceKind === 'git' ? (
        <div className="mt-2 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={`add-source-url-${resource.id}`} className="text-xs">
              Repository URL
            </Label>
            <Input
              id={`add-source-url-${resource.id}`}
              value={repoUrl}
              onChange={event => setRepoUrl(event.target.value)}
              placeholder="https://github.com/org/repo.git"
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              onKeyDown={event => {
                if (event.key === 'Enter') void handleAddSource();
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Repo sources are shared across all execution targets for this project.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            disabled={createResource.isPending}
            onClick={() => void handleAddSource()}
          >
            <Plus className="size-3.5" />
            Add source
          </Button>
        </div>
      ) : (
        <div className="mt-2 grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem_auto] lg:items-end">
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={`add-source-path-${resource.id}`} className="text-xs">
              Directory path
            </Label>
            <div className="flex gap-2">
              <Input
                id={`add-source-path-${resource.id}`}
                value={directoryPath}
                onChange={event => setDirectoryPath(event.target.value)}
                placeholder="/path/to/checkout"
                className="h-8 min-w-0 flex-1 font-mono text-xs"
                onKeyDown={event => {
                  if (event.key === 'Enter') void handleAddSource();
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
            <Label htmlFor={`add-source-target-${resource.id}`} className="text-xs">
              Execution target
            </Label>
            <Select
              value={targetValue}
              onValueChange={value => setTargetValue(value ?? targetValue)}
            >
              <SelectTrigger id={`add-source-target-${resource.id}`} className="h-8">
                <SelectValue placeholder="Execution target">
                  {executionTargetSelectorDisplayLabel({
                    selectorValue: targetValue,
                    eligibleTargets,
                    anyLabel: 'Any target'
                  })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_ELIGIBLE_EXECUTION_TARGET_VALUE}>Any target</SelectItem>
                {eligibleTargets.map(target => (
                  <SelectItem key={target.executionTargetId} value={target.executionTargetId}>
                    {executionTargetOptionLabel(target)}
                    {executionTargetOptionStatusSuffix(target)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            disabled={createResource.isPending}
            onClick={() => void handleAddSource()}
          >
            <Plus className="size-3.5" />
            Add source
          </Button>
        </div>
      )}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function ResourcesPage({ open, projectId }: ResourcesPageProps) {
  const { eligibleTargets, selectedExecutionTargetId } = useProjectRepositoryContext();
  const updateExecutionTarget = useUpdateProjectExecutionTarget(projectId);
  const resourcesQ = useProjectResources(projectId);
  const launchSettingsQ = useLaunchSettings();
  const projectQ = useProject(projectId);
  const updateProject = useUpdateProject(projectId);
  const updateResource = useUpdateProjectResource(projectId);
  const deleteResource = useDeleteProjectResource(projectId);

  const rows = open ? (resourcesQ.data ?? []) : [];
  const localExecutionTargetId = launchSettingsQ.data?.executionTargetId ?? null;
  const deviceLabel = launchSettingsQ.data?.deviceLabel ?? 'This device';
  const activeExecutionTargetId = selectedExecutionTargetId ?? localExecutionTargetId;
  const hasMissingPrimary = rows.some(
    resource => resource.isPrimary && resource.status === 'missing'
  );

  const [targetError, setTargetError] = useState<string | null>(null);
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

  function resolveTargetLabel(executionTargetId: string | null): string {
    return targetLabelForId({
      executionTargetId,
      eligibleTargets,
      localExecutionTargetId,
      deviceLabel
    });
  }

  function handleExecutionTargetChange(value: string | null) {
    setTargetError(null);
    updateExecutionTarget.mutate(
      { executionTargetId: !value ? null : parseExecutionTargetSelectorValue(value) },
      {
        onError: error => {
          setTargetError(
            error instanceof Error ? error.message : 'Failed to update execution target.'
          );
        }
      }
    );
  }

  const selectorValue = resolveExecutionTargetSelectorValue({
    selectedExecutionTargetId,
    eligibleTargets
  });
  // Sources added from within a resource default to the project's active target.
  const addSourceDefaultValue =
    activeExecutionTargetId &&
    eligibleTargets.some(target => target.executionTargetId === activeExecutionTargetId)
      ? activeExecutionTargetId
      : ANY_ELIGIBLE_EXECUTION_TARGET_VALUE;

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
      setDeleteError(error instanceof Error ? error.message : 'Failed to remove resource.');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Resources</h2>
        <p className="text-sm text-muted-foreground">
          Choose where agents run for this project, then manage each resource and the checkout
          sources that back it per execution target.
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
                <SelectValue placeholder="Select execution target">
                  {executionTargetSelectorDisplayLabel({
                    selectorValue,
                    eligibleTargets,
                    placeholder: 'Select execution target'
                  })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {eligibleTargets.length > 1 ? (
                  <SelectItem value={ANY_ELIGIBLE_EXECUTION_TARGET_VALUE}>
                    Any eligible target
                  </SelectItem>
                ) : null}
                {eligibleTargets.map(target => (
                  <SelectItem
                    key={target.executionTargetId}
                    value={target.executionTargetId}
                    disabled={!target.reachable || !target.primaryResourceConnected}
                  >
                    {executionTargetOptionLabel(target)}
                    {executionTargetOptionStatusSuffix(target)}
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
            A primary working directory is missing. Set another resource as primary before launching
            agents from this project.
          </p>
        </div>
      ) : null}

      {resourcesQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading resources…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No resources linked yet.
        </div>
      ) : (
        <Accordion multiple className="overflow-hidden rounded-lg border px-4">
          {rows.map(resource => (
            <AccordionItem key={resource.id} value={resource.id}>
              <div className="flex items-center gap-1">
                <AccordionTrigger className="flex-1 hover:no-underline">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-sm">{resource.resourceKey}</span>
                    {resource.isPrimary ? (
                      <Badge variant="secondary" className="shrink-0">
                        Primary
                      </Badge>
                    ) : null}
                    <Badge
                      variant={resource.status === 'missing' ? 'destructive' : 'outline'}
                      className="shrink-0 font-normal"
                    >
                      {resourceStatusLabel(resource.status)}
                    </Badge>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {resource.sources.length}{' '}
                      {resource.sources.length === 1 ? 'source' : 'sources'}
                    </span>
                  </span>
                </AccordionTrigger>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-destructive hover:text-destructive"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteTarget(resource);
                  }}
                  aria-label={`Remove ${resource.resourceKey}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <AccordionContent className="space-y-4 pt-2">
                <div className="grid gap-1.5 sm:max-w-md">
                  <Label htmlFor={`resource-key-${resource.id}`} className="text-xs">
                    Resource key
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`resource-key-${resource.id}`}
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
                      className="h-8 min-w-0 font-mono text-xs"
                    />
                    {(resourceKeyEdits[resource.id] ?? resource.resourceKey).trim() !==
                    resource.resourceKey ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8"
                        disabled={updateResource.isPending}
                        onClick={() => void handleSaveResourceKey(resource)}
                      >
                        Save
                      </Button>
                    ) : null}
                    {!resource.isPrimary ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-8"
                        disabled={updateResource.isPending}
                        onClick={() => void handleSetPrimary(resource)}
                      >
                        Make primary
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-muted-foreground">Sources</h4>
                  {resource.sources.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No sources linked yet.</p>
                  ) : (
                    <ul className="space-y-2">
                      {resource.sources.map(source => (
                        <SourceRow
                          key={source.id}
                          source={source}
                          label={resolveTargetLabel(source.executionTargetId)}
                        />
                      ))}
                    </ul>
                  )}
                </div>

                <AddSourceForm
                  projectId={projectId}
                  resource={resource}
                  eligibleTargets={eligibleTargets}
                  defaultTargetValue={addSourceDefaultValue}
                  onAdded={() => void resourcesQ.refetch()}
                />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
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
            <DialogTitle>Remove resource</DialogTitle>
            <DialogDescription>
              Remove resource &ldquo;{deleteTarget?.resourceKey}&rdquo; and all of its sources from
              this project?
              {deleteTarget?.sources.length ? (
                <span className="mt-2 block font-mono text-xs text-muted-foreground">
                  {deleteTarget.sources
                    .map(
                      source => sourceDescriptorValue(source) || sourceKindLabel(source.sourceKind)
                    )
                    .join(' · ')}
                </span>
              ) : null}
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
              Remove resource
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
