import {
  AlertTriangle,
  FolderOpen,
  GitBranch,
  HardDrive,
  Pencil,
  Plus,
  Trash2,
  X
} from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
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
  useDeleteProjectResourceSource,
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
  ProjectResourceAccessMode,
  ProjectResourceDto,
  ProjectResourceSourceDto
} from '../../../../shared/contract.ts';

const ACCESS_MODE_OPTIONS: { value: ProjectResourceAccessMode; label: string }[] = [
  { value: 'read', label: 'Read' },
  { value: 'read_write', label: 'Read & write' }
];

function accessModeLabel(mode: ProjectResourceAccessMode): string {
  return mode === 'read' ? 'Read' : 'Read & write';
}

function accessModeHelpText(mode: ProjectResourceAccessMode): string {
  return mode === 'read'
    ? 'Reference resource: agents can read/navigate it, but it is not offered in the resource picker and is not linked into .overlord/project.json.'
    : 'Full access: offered in the resource picker and linked as a working directory.';
}

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

function SourceRow({
  projectId,
  resource,
  source,
  label,
  onSaved
}: {
  projectId: string;
  resource: ProjectResourceDto;
  source: ProjectResourceSourceDto;
  label: string;
  onSaved: () => void;
}) {
  const { copied, copy } = useCopyToClipboard();
  const createResource = useCreateProjectResource(projectId);
  const deleteSource = useDeleteProjectResourceSource(projectId);
  const value = sourceDescriptorValue(source);
  const isGit = source.sourceKind === 'git';
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setDraft(value);
    setError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    setIsEditing(false);
    setError(null);
  }

  async function handleDelete() {
    setError(null);
    try {
      await deleteSource.mutateAsync({ resourceId: resource.id, sourceId: source.id });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove source.');
    }
  }

  // Editing re-runs the create/upsert with the source's own execution target and
  // kind, so the backend updates the existing descriptor in place rather than
  // adding a second source for the same resource-target combination.
  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError(isGit ? 'Enter a repository URL.' : 'Enter a directory path.');
      return;
    }
    if (trimmed === value) {
      setIsEditing(false);
      return;
    }
    setError(null);
    try {
      if (isGit) {
        await createResource.mutateAsync({
          sourceUrl: trimmed,
          resourceKey: resource.resourceKey,
          executionTargetId: source.executionTargetId,
          isPrimary: resource.isPrimary
        });
      } else {
        const created = await createResource.mutateAsync({
          directoryPath: trimmed,
          resourceKey: resource.resourceKey,
          executionTargetId: source.executionTargetId,
          isPrimary: resource.isPrimary
        });
        // coo:368: `read` (reference) resources are never linked into project.json.
        if (created.accessMode !== 'read') {
          await writeLocalProjectMetadata({ directoryPath: trimmed, projectId, resource: created });
        }
      }
      setIsEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update source.');
    }
  }

  if (isEditing) {
    return (
      <li className="min-w-0">
        <div className="flex flex-col gap-2 rounded-md border px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="shrink-0 font-normal">
              {sourceKindLabel(source.sourceKind)}
            </Badge>
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={event => setDraft(event.target.value)}
              placeholder={isGit ? 'https://github.com/org/repo.git' : '/path/to/checkout'}
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              autoFocus
              onKeyDown={event => {
                if (event.key === 'Enter') void handleSave();
                if (event.key === 'Escape') cancelEditing();
              }}
            />
            <Button
              type="button"
              size="sm"
              className="h-8"
              disabled={createResource.isPending}
              onClick={() => void handleSave()}
            >
              Save
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              onClick={cancelEditing}
              aria-label="Cancel editing source"
            >
              <X className="size-4" />
            </Button>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </li>
    );
  }

  return (
    <li className="flex min-w-0 items-center gap-1">
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
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 shrink-0"
        onClick={startEditing}
        aria-label={`Edit source ${value || sourceKindLabel(source.sourceKind)}`}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        disabled={deleteSource.isPending}
        onClick={() => void handleDelete()}
        aria-label={`Remove source ${value || sourceKindLabel(source.sourceKind)}`}
      >
        <Trash2 className="size-3.5" />
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
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
  // A source is unique per (resource, execution target, kind). Local checkouts are
  // scoped per target; a git source is project-global (one per resource). We use
  // these sets to keep the add flow from creating a duplicate combination — the
  // backend would silently replace it, which is confusing. Users edit instead.
  const usedLocalTargetIds = new Set<string | null>(
    resource.sources
      .filter(source => source.sourceKind === 'local_checkout')
      .map(source => source.executionTargetId)
  );
  const hasGitSource = resource.sources.some(source => source.sourceKind === 'git');

  const isLocalTargetInUse = (selectorValue: string) =>
    usedLocalTargetIds.has(parseExecutionTargetSelectorValue(selectorValue));

  // Prefer a target that does not already have a local source so the default
  // selection is immediately usable.
  function firstAvailableTargetValue(): string {
    if (!isLocalTargetInUse(defaultTargetValue)) return defaultTargetValue;
    if (!usedLocalTargetIds.has(null)) return ANY_ELIGIBLE_EXECUTION_TARGET_VALUE;
    const available = eligibleTargets.find(
      target => !usedLocalTargetIds.has(target.executionTargetId)
    );
    return available ? available.executionTargetId : defaultTargetValue;
  }

  const [sourceKind, setSourceKind] = useState<AddSourceKind>('local_checkout');
  const [directoryPath, setDirectoryPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [targetValue, setTargetValue] = useState(() => firstAvailableTargetValue());
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canBrowseDirectories =
    typeof window !== 'undefined' && typeof window.overlord?.chooseDirectory === 'function';

  useEffect(() => {
    setTargetValue(firstAvailableTargetValue());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTargetValue, resource.sources]);

  const selectedTargetInUse = sourceKind === 'local_checkout' && isLocalTargetInUse(targetValue);
  const gitAlreadyExists = sourceKind === 'git' && hasGitSource;
  const addDisabled = createResource.isPending || selectedTargetInUse || gitAlreadyExists;

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
      if (hasGitSource) {
        setError('This resource already has a repo source. Edit it instead.');
        return;
      }
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

    if (selectedTargetInUse) {
      setError('This execution target already has a local source. Edit it instead.');
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
      // coo:368: `read` (reference) resources are never linked into project.json.
      if (created.accessMode !== 'read') {
        await writeLocalProjectMetadata({ directoryPath: trimmed, projectId, resource: created });
      }
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
            // A resource already backed by a repo source cannot take a second one.
            const optionDisabled = option.value === 'git' && hasGitSource;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={optionDisabled}
                title={optionDisabled ? 'This resource already has a repo source' : undefined}
                onClick={() => {
                  setSourceKind(option.value);
                  setError(null);
                }}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                  optionDisabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground'
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
            disabled={addDisabled}
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
                <SelectItem
                  value={ANY_ELIGIBLE_EXECUTION_TARGET_VALUE}
                  disabled={usedLocalTargetIds.has(null)}
                >
                  Any target{usedLocalTargetIds.has(null) ? ' (in use)' : ''}
                </SelectItem>
                {eligibleTargets.map(target => {
                  const inUse = usedLocalTargetIds.has(target.executionTargetId);
                  return (
                    <SelectItem
                      key={target.executionTargetId}
                      value={target.executionTargetId}
                      disabled={inUse}
                    >
                      {executionTargetOptionLabel(target)}
                      {inUse ? ' (in use)' : executionTargetOptionStatusSuffix(target)}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            disabled={addDisabled}
            onClick={() => void handleAddSource()}
          >
            <Plus className="size-3.5" />
            Add source
          </Button>
        </div>
      )}
      {selectedTargetInUse ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          This execution target already has a local source. Edit the existing source above instead
          of adding a duplicate.
        </p>
      ) : null}
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function AddResourceDialog({
  projectId,
  eligibleTargets,
  defaultTargetValue,
  existingResourceKeys,
  isFirstResource,
  open,
  onOpenChange,
  onCreated
}: {
  projectId: string;
  eligibleTargets: EligibleExecutionTargetDto[];
  defaultTargetValue: string;
  existingResourceKeys: string[];
  isFirstResource: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const createResource = useCreateProjectResource(projectId);
  const [resourceKey, setResourceKey] = useState('');
  const [sourceKind, setSourceKind] = useState<AddSourceKind>('local_checkout');
  const [directoryPath, setDirectoryPath] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [targetValue, setTargetValue] = useState(defaultTargetValue);
  const [makePrimary, setMakePrimary] = useState(isFirstResource);
  // coo:368: primary resources are always read & write; a non-primary resource
  // defaults to `read`.
  const [accessMode, setAccessMode] = useState<ProjectResourceAccessMode>(
    isFirstResource ? 'read_write' : 'read'
  );
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canBrowseDirectories =
    typeof window !== 'undefined' && typeof window.overlord?.chooseDirectory === 'function';

  // Reset the form each time the dialog opens so stale input never leaks between
  // separate add-resource attempts.
  useEffect(() => {
    if (!open) return;
    setResourceKey('');
    setSourceKind('local_checkout');
    setDirectoryPath('');
    setRepoUrl('');
    setTargetValue(defaultTargetValue);
    setMakePrimary(isFirstResource);
    setAccessMode(isFirstResource ? 'read_write' : 'read');
    setError(null);
  }, [open, defaultTargetValue, isFirstResource]);

  // Keep the access mode consistent with the primary toggle: a primary resource
  // is always read & write.
  const effectiveAccessMode: ProjectResourceAccessMode = makePrimary ? 'read_write' : accessMode;

  const trimmedKey = resourceKey.trim();
  const duplicateKey = trimmedKey.length > 0 && existingResourceKeys.includes(trimmedKey);

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

  async function handleCreate() {
    if (duplicateKey) {
      setError('A resource with this key already exists. Add a source to it instead.');
      return;
    }
    // An explicit key must be unique; omitting it lets the backend derive one from
    // the path/URL. Primary is opt-in so adding a resource never silently steals
    // primary from an existing checkout unless the user asks for it.
    const isPrimary = makePrimary;
    if (sourceKind === 'git') {
      const trimmedUrl = repoUrl.trim();
      if (!trimmedUrl) {
        setError('Enter a repository URL.');
        return;
      }
      setError(null);
      try {
        await createResource.mutateAsync({
          sourceUrl: trimmedUrl,
          resourceKey: trimmedKey || null,
          isPrimary,
          accessMode: effectiveAccessMode
        });
        onCreated();
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add resource.');
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
        resourceKey: trimmedKey || null,
        executionTargetId,
        isPrimary,
        accessMode: effectiveAccessMode
      });
      // coo:368: `read` (reference) resources are never linked into
      // `.overlord/project.json`.
      if (created.accessMode !== 'read') {
        await writeLocalProjectMetadata({ directoryPath: trimmed, projectId, resource: created });
      }
      onCreated();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add resource.');
    }
  }

  const kindOptions: { value: AddSourceKind; label: string; icon: typeof HardDrive }[] = [
    { value: 'local_checkout', label: 'Local path', icon: HardDrive },
    { value: 'git', label: 'Repo URL', icon: GitBranch }
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add resource</DialogTitle>
          <DialogDescription>
            Create a new logical resource for this project and link its first source. Leave the key
            blank to derive one from the path or URL.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="add-resource-key" className="text-xs">
              Resource key (optional)
            </Label>
            <Input
              id="add-resource-key"
              value={resourceKey}
              onChange={event => {
                setResourceKey(event.target.value);
                setError(null);
              }}
              placeholder="e.g. frontend"
              className="h-8 font-mono text-xs"
            />
            {duplicateKey ? (
              <p className="text-[11px] text-destructive">
                A resource with this key already exists.
              </p>
            ) : null}
          </div>

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

          {sourceKind === 'git' ? (
            <div className="grid gap-1.5">
              <Label htmlFor="add-resource-url" className="text-xs">
                Repository URL
              </Label>
              <Input
                id="add-resource-url"
                value={repoUrl}
                onChange={event => setRepoUrl(event.target.value)}
                placeholder="https://github.com/org/repo.git"
                className="h-8 font-mono text-xs"
                onKeyDown={event => {
                  if (event.key === 'Enter') void handleCreate();
                }}
              />
              <p className="text-[11px] text-muted-foreground">
                Repo sources are shared across all execution targets for this project.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="add-resource-path" className="text-xs">
                  Directory path
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="add-resource-path"
                    value={directoryPath}
                    onChange={event => setDirectoryPath(event.target.value)}
                    placeholder="/path/to/checkout"
                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                    onKeyDown={event => {
                      if (event.key === 'Enter') void handleCreate();
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
              <div className="grid gap-1.5">
                <Label htmlFor="add-resource-target" className="text-xs">
                  Execution target
                </Label>
                <Select
                  value={targetValue}
                  onValueChange={value => setTargetValue(value ?? targetValue)}
                >
                  <SelectTrigger id="add-resource-target" className="h-8">
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
            </>
          )}

          <div className="flex items-center justify-between gap-2">
            <div className="grid gap-0.5">
              <Label htmlFor="add-resource-primary" className="text-xs">
                Set as primary resource
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Primary backs the default working directory agents run in.
              </p>
            </div>
            <Switch
              id="add-resource-primary"
              checked={makePrimary}
              onCheckedChange={setMakePrimary}
            />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">Permission</Label>
            <div
              role="radiogroup"
              aria-label="Resource permission"
              className="inline-flex rounded-md border p-0.5"
            >
              {ACCESS_MODE_OPTIONS.map(option => {
                const active = effectiveAccessMode === option.value;
                // A primary resource is pinned to read & write.
                const locked = makePrimary && option.value === 'read';
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={locked}
                    onClick={() => {
                      setAccessMode(option.value);
                      setError(null);
                    }}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                      locked && 'cursor-not-allowed opacity-40'
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {makePrimary
                ? 'Primary resources are always read & write.'
                : accessModeHelpText(effectiveAccessMode)}
            </p>
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            className="gap-1.5"
            disabled={createResource.isPending || duplicateKey}
            onClick={() => void handleCreate()}
          >
            <Plus className="size-3.5" />
            Add resource
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [addResourceOpen, setAddResourceOpen] = useState(false);

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

  async function handleSetAccessMode(
    resource: ProjectResourceDto,
    accessMode: ProjectResourceAccessMode
  ) {
    // Primary resources are pinned to read & write; nothing to toggle.
    if (resource.isPrimary || resource.accessMode === accessMode) return;
    setRowError(null);
    try {
      await updateResource.mutateAsync({ resourceId: resource.id, body: { accessMode } });
    } catch (error) {
      setRowError(error instanceof Error ? error.message : 'Failed to update resource permission.');
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

      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Linked resources</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          onClick={() => setAddResourceOpen(true)}
        >
          <Plus className="size-3.5" />
          Add resource
        </Button>
      </div>

      {resourcesQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading resources…</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          <p>No resources linked yet.</p>
          <Button
            type="button"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setAddResourceOpen(true)}
          >
            <Plus className="size-3.5" />
            Add resource
          </Button>
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
                    <Badge variant="outline" className="shrink-0 font-normal">
                      {accessModeLabel(resource.accessMode)}
                    </Badge>
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

                <div className="grid gap-1.5 sm:max-w-md">
                  <Label className="text-xs">Permission</Label>
                  <div
                    role="radiogroup"
                    aria-label={`Permission for ${resource.resourceKey}`}
                    className="inline-flex w-fit rounded-md border p-0.5"
                  >
                    {ACCESS_MODE_OPTIONS.map(option => {
                      const active = resource.accessMode === option.value;
                      // Primary resources are pinned to read & write.
                      const locked = resource.isPrimary;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={locked || updateResource.isPending}
                          onClick={() => void handleSetAccessMode(resource, option.value)}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors',
                            active
                              ? 'bg-primary text-primary-foreground'
                              : 'text-muted-foreground hover:text-foreground',
                            locked && !active && 'cursor-not-allowed opacity-40'
                          )}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {resource.isPrimary
                      ? 'Primary resources are always read & write.'
                      : accessModeHelpText(resource.accessMode)}
                  </p>
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
                          projectId={projectId}
                          resource={resource}
                          source={source}
                          label={resolveTargetLabel(source.executionTargetId)}
                          onSaved={() => void resourcesQ.refetch()}
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

      <AddResourceDialog
        projectId={projectId}
        eligibleTargets={eligibleTargets}
        defaultTargetValue={addSourceDefaultValue}
        existingResourceKeys={rows.map(resource => resource.resourceKey)}
        isFirstResource={rows.length === 0}
        open={addResourceOpen}
        onOpenChange={setAddResourceOpen}
        onCreated={() => void resourcesQ.refetch()}
      />

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
