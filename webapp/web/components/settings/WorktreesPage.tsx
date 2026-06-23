import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ApiRequestError } from '@/lib/api';
import {
  useLaunchSettings,
  usePurgeMergedWorktrees,
  useRemoveWorktree,
  useUpdateWorktreeBranchAutomation,
  useWorktrees
} from '@/lib/queries';

import type { WorktreeDto } from '../../../shared/contract.ts';

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function statusLabel(worktree: WorktreeDto): string {
  if (worktree.dirty) return 'uncommitted changes';
  switch (worktree.status) {
    case 'merged':
      return 'merged';
    case 'merged_unpushed':
      return 'merged · unpushed';
    case 'published':
      return 'published';
    case 'created':
      return 'active';
    default:
      return worktree.branch ? 'active' : 'detached';
  }
}

function WorktreeRow({ worktree }: { worktree: WorktreeDto }) {
  const remove = useRemoveWorktree();
  const [confirmForce, setConfirmForce] = useState(false);

  function handleRemove(force: boolean): void {
    remove.mutate(
      { path: worktree.path, force },
      {
        onSuccess: () => setConfirmForce(false),
        onError: error => {
          if (error instanceof ApiRequestError && error.code === 'WORKTREE_DIRTY') {
            setConfirmForce(true);
          }
        }
      }
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <code className="truncate text-xs font-medium">{worktree.branch ?? '(detached)'}</code>
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                worktree.merged
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : worktree.dirty
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {statusLabel(worktree)}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{worktree.path}</p>
          <p className="text-xs text-muted-foreground">
            {worktree.projectName}
            {worktree.missionDisplayId ? ` · ${worktree.missionDisplayId}` : ''} ·{' '}
            {formatBytes(worktree.sizeBytes)} · {formatWhen(worktree.lastModifiedAt)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          onClick={() => handleRemove(false)}
        >
          Delete
        </Button>
      </div>
      {confirmForce && (
        <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
          <p>This worktree has uncommitted changes. Deleting it will lose that work.</p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending}
              onClick={() => handleRemove(true)}
            >
              Delete anyway
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmForce(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {remove.isError && !confirmForce && (
        <p className="text-xs text-red-400">{(remove.error as Error).message}</p>
      )}
    </div>
  );
}

export function WorktreesPage() {
  const launchSettings = useLaunchSettings();
  const updateWorktrees = useUpdateWorktreeBranchAutomation();
  const worktreesEnabled = launchSettings.data?.worktreeBranchAutomationEnabled ?? false;

  const worktrees = useWorktrees();
  const purgeMerged = usePurgeMergedWorktrees();
  const list = worktrees.data ?? [];
  const mergedCount = list.filter(w => w.merged && !w.dirty).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Worktrees</h2>
        <p className="text-sm text-muted-foreground">
          Control how Overlord isolates mission work in branches and worktrees.
        </p>
      </div>

      <div className="max-w-md space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="worktree-branch-automation">Mission worktrees</Label>
            <p className="text-xs text-muted-foreground">
              Launch each mission in its own branch and worktree under the Overlord home folder.
            </p>
          </div>
          <Switch
            id="worktree-branch-automation"
            checked={worktreesEnabled}
            disabled={launchSettings.isLoading || updateWorktrees.isPending}
            onCheckedChange={enabled => updateWorktrees.mutate({ enabled })}
          />
        </div>
        {updateWorktrees.isError && (
          <p className="text-xs text-red-400">{(updateWorktrees.error as Error).message}</p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">Existing worktrees</h3>
            <p className="text-xs text-muted-foreground">
              Worktrees Overlord created under its home folder. Deleting one removes its checkout;
              merged branches are safe to purge.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            disabled={mergedCount === 0 || purgeMerged.isPending}
            onClick={() => purgeMerged.mutate()}
          >
            Purge all merged{mergedCount > 0 ? ` (${mergedCount})` : ''}
          </Button>
        </div>
        {purgeMerged.isError && (
          <p className="text-xs text-red-400">{(purgeMerged.error as Error).message}</p>
        )}
        {purgeMerged.data && purgeMerged.data.skipped.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Skipped {purgeMerged.data.skipped.length} worktree
            {purgeMerged.data.skipped.length === 1 ? '' : 's'} with uncommitted changes.
          </p>
        )}

        {worktrees.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading worktrees…</p>
        ) : list.length === 0 ? (
          <p className="text-xs text-muted-foreground">No worktrees yet.</p>
        ) : (
          <div className="space-y-2">
            {list.map(worktree => (
              <WorktreeRow key={worktree.path} worktree={worktree} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
