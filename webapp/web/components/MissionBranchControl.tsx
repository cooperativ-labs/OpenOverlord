import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  Loader2,
  RefreshCw,
  Sparkles,
  Terminal
} from 'lucide-react';
import { useState } from 'react';

import type {
  MissionBranchDto,
  MissionBranchStatus,
  MissionDetailDto
} from '../../shared/contract.ts';
import { ApiRequestError } from '../lib/api.ts';
import {
  useBranchAction,
  useGenerateCommitMessage,
  useMissionBranches,
  useUpdateMission
} from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';

import { Button as IconButton } from './ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';
import { Button } from './ui.tsx';

type BranchActionName = 'integrate' | 'commit' | 'push_parent' | 'publish';

// Sentinel for the "Automatic" choice — mapped to clearing the override
// (branchOverride: null) rather than pinning a named branch.
const AUTO_BRANCH = '__auto__';

// Visual treatment per branch lifecycle state. A colored dot is the primary
// indicator (scannable at a glance); the tinted pill reinforces it, and the
// status icon fronts the header one-liner. Kept as a lookup table rather than
// nested ternaries so the states read as a set.
const BRANCH_STATUS_META: Record<
  MissionBranchStatus,
  { label: string; dot: string; pill: string; icon: LucideIcon; accent: string }
> = {
  pending: {
    label: 'Not created',
    dot: 'bg-muted-foreground/40',
    pill: 'bg-muted text-muted-foreground',
    icon: GitBranch,
    accent: 'text-muted-foreground'
  },
  created: {
    label: 'Created',
    dot: 'bg-sky-500',
    pill: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    icon: GitBranch,
    accent: 'text-sky-600 dark:text-sky-400'
  },
  published: {
    label: 'Published',
    dot: 'bg-violet-500',
    pill: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
    icon: GitBranchPlus,
    accent: 'text-violet-600 dark:text-violet-400'
  },
  merged_unpushed: {
    label: 'Merged · unpushed',
    dot: 'bg-amber-500',
    pill: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    icon: GitMerge,
    accent: 'text-amber-600 dark:text-amber-400'
  },
  merged: {
    label: 'Merged',
    dot: 'bg-emerald-500',
    pill: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    icon: GitMerge,
    accent: 'text-emerald-600 dark:text-emerald-400'
  }
};

function CopyIconButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={() => void copy()}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </IconButton>
        }
      />
      <TooltipContent>{copied ? 'Copied' : label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A single copy affordance for the branch's identity. Opens a dropdown so the
 * three things people actually paste — the branch name, a ready-to-run `cd`
 * command, and the worktree path — live behind one button instead of a row of
 * separate icon buttons. The worktree-derived items are disabled until a
 * worktree exists (i.e. before the branch is prepared).
 */
function BranchCopyMenu({ branch }: { branch: MissionBranchDto }) {
  const [copied, setCopied] = useState(false);
  const path = branch.worktreePath;
  const cdCommand = path ? `cd ${JSON.stringify(path)}` : null;

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<IconButton type="button" variant="outline" size="xs" className="gap-1" />}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onClick={() => copy(branch.name)}>
          <GitBranch />
          Branch name
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!cdCommand}
          onClick={() => {
            if (cdCommand) copy(cdCommand);
          }}
        >
          <Terminal />
          cd into worktree
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!path}
          onClick={() => {
            if (path) copy(path);
          }}
        >
          <FolderOpen />
          Worktree path
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Renders the mission's branch name as the trigger for a menu that lets the user
 * pin a different branch when the system-chosen default is wrong. The choice is
 * stored as the mission's `branchOverride` and consumed by the runner at the next
 * launch (no git side-effects here). Branches are fetched lazily — only once the
 * menu is opened.
 */
function BranchSelector({ mission }: { mission: MissionDetailDto }) {
  const [open, setOpen] = useState(false);
  const branches = useMissionBranches(mission.id, open);
  const update = useUpdateMission(mission.id);
  const override = mission.branch?.overrideBranch ?? null;
  const branchName = mission.branch?.name ?? '';
  const selected = override ?? AUTO_BRANCH;

  function handleChange(value: string): void {
    update.mutate({ branchOverride: value === AUTO_BRANCH ? null : value });
  }

  const options = branches.data?.branches ?? [];

  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger
            type="button"
            aria-label="Change branch"
            disabled={update.isPending}
            className="flex min-w-0 flex-1 items-center gap-1 rounded text-left underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <code className="min-w-0 flex-1 truncate text-[0.8rem] font-medium" title={branchName}>
              {branchName}
            </code>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuItem onClick={() => handleChange(AUTO_BRANCH)}>
              <Check
                className={cn('h-3 w-3', selected === AUTO_BRANCH ? 'opacity-100' : 'opacity-0')}
              />
              Automatic (system default)
            </DropdownMenuItem>
            {branches.isLoading && <DropdownMenuItem disabled>Loading branches…</DropdownMenuItem>}
            {options.map(name => (
              <DropdownMenuItem key={name} onClick={() => handleChange(name)}>
                <Check className={cn('h-3 w-3', selected === name ? 'opacity-100' : 'opacity-0')} />
                {name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {update.isError && (
        <p className="text-xs text-destructive">{(update.error as Error).message}</p>
      )}
    </div>
  );
}

/**
 * The full git control surface for a mission's branch: status, identity, and the
 * lifecycle actions (commit, merge in parent, push, publish, open a PR). Rendered
 * inside the header popover; its layout assumes the surrounding popover supplies
 * the padding and surface.
 */
function BranchPanel({ mission }: { mission: MissionDetailDto }) {
  const branch = mission.branch;
  const branchAction = useBranchAction(mission.id);
  const generateCommitMessage = useGenerateCommitMessage(mission.id);
  const [actionError, setActionError] = useState<string | null>(null);
  // When an action needs confirmation (an objective is executing on the branch),
  // we stash the intended action and surface an inline confirm prompt.
  const [confirmAction, setConfirmAction] = useState<BranchActionName | null>(null);
  // The commit message captured before merging, while the branch worktree is dirty.
  const [commitMessage, setCommitMessage] = useState('');

  if (!branch) return null;
  const status = BRANCH_STATUS_META[branch.status];

  const parent = branch.baseBranch ?? 'main';
  // A GitHub PR can only target a pushed branch, so this is offered on `published`.
  const prCommand = `gh pr create --base ${parent} --head ${branch.name} --fill --web`;
  // The DTO carries only the active (queued/claimed/launching) execution requests.
  const isExecuting = mission.executionRequests.length > 0;
  const actionLabels: Record<BranchActionName, string> = {
    integrate: `Merge in ${parent}`,
    commit: 'Commit changes',
    push_parent: `Push ${parent}`,
    publish: 'Publish'
  };

  async function runAction(
    action: BranchActionName,
    confirmBusy: boolean,
    message?: string
  ): Promise<void> {
    setActionError(null);
    try {
      await branchAction.mutateAsync({ action, confirmBusy, message });
      setConfirmAction(null);
      if (action === 'commit') setCommitMessage('');
    } catch (err) {
      // The server re-checks execution state; a fresh busy result re-opens the prompt.
      if (err instanceof ApiRequestError && err.code === 'BRANCH_BUSY_EXECUTING' && !confirmBusy) {
        setConfirmAction(action);
        return;
      }
      setConfirmAction(null);
      setActionError(err instanceof Error ? err.message : 'Branch action failed.');
    }
  }

  function handleAction(action: BranchActionName, message?: string): void {
    if (isExecuting) {
      setActionError(null);
      setConfirmAction(action);
      return;
    }
    void runAction(action, false, message);
  }

  // Drafts a commit message from the worktree diff and drops it into the field
  // for the user to edit before committing.
  function handleGenerateCommitMessage(): void {
    if (generateCommitMessage.isPending || branchAction.isPending) return;
    generateCommitMessage.mutate(undefined, {
      onSuccess: result => setCommitMessage(result.message)
    });
  }

  const onMergeableBranch = branch.status === 'created' || branch.status === 'published';
  // The branch must be committed before it can be merged: while its worktree has
  // uncommitted changes we ask the user to commit first; only a clean worktree
  // gets the "Update from parent & merge" affordance.
  const showCommit = onMergeableBranch && branch.dirty;
  const showIntegrate = onMergeableBranch && !branch.dirty;
  const showPushParent = branch.status === 'merged_unpushed';
  const showPublish = branch.status === 'created';
  const showCreatePr = branch.status === 'published';
  const commitMessageValid = commitMessage.trim().length > 0;
  const hasActions = showIntegrate || showPushParent || showPublish;

  return (
    <TooltipProvider>
      <div className="space-y-3 text-sm">
        {/* Status indicator + the single copy affordance. */}
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
              status.pill
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', status.dot)} aria-hidden />
            {status.label}
          </span>
          <BranchCopyMenu branch={branch} />
        </div>

        {/* Identity: the branch name (click to pin a different branch), with its
            parent beneath it. */}
        <div className="space-y-1">
          <BranchSelector mission={mission} />
          <div className="flex min-w-0 items-center gap-1.5 pl-6 text-xs text-muted-foreground">
            <span aria-hidden>↳</span>
            <span className="shrink-0">from</span>
            <code className="min-w-0 truncate text-[0.7rem]" title={parent}>
              {parent}
            </code>
          </div>
        </div>

        {showCommit && (
          <div className="space-y-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5">
            <p className="text-xs text-amber-800 dark:text-amber-200">
              Uncommitted changes on this branch. Commit them before updating from {parent}.
            </p>
            {/* The Sparkles button overlays the textarea's top-right corner so
                the AI-draft affordance reads as part of the field. Cmd/Ctrl+Enter
                commits; bare Enter inserts a newline (it's a multi-line field). */}
            <div className="relative">
              <textarea
                rows={3}
                value={commitMessage}
                onChange={event => setCommitMessage(event.target.value)}
                placeholder="Describe your changes…"
                aria-label="Commit message"
                disabled={branchAction.isPending}
                onKeyDown={event => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === 'Enter' &&
                    commitMessageValid &&
                    !branchAction.isPending
                  ) {
                    event.preventDefault();
                    handleAction('commit', commitMessage.trim());
                  }
                }}
                className="w-full resize-y rounded-md border border-amber-500/30 bg-background/70 px-2.5 py-1.5 pr-9 text-xs leading-relaxed shadow-sm focus:border-amber-500/60 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Draft commit message with AI"
                      className="absolute right-1.5 top-1.5"
                      disabled={branchAction.isPending || generateCommitMessage.isPending}
                      onClick={handleGenerateCommitMessage}
                    />
                  }
                >
                  {generateCommitMessage.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles
                      className={cn(
                        'h-3.5 w-3.5',
                        generateCommitMessage.isError && 'text-destructive'
                      )}
                    />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  {generateCommitMessage.isError
                    ? (generateCommitMessage.error as Error).message
                    : 'Draft commit message with AI'}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.7rem] text-amber-700/80 dark:text-amber-300/70">
                ⌘↵ to commit
              </span>
              <Button
                variant="primary"
                disabled={branchAction.isPending || !commitMessageValid}
                onClick={() => handleAction('commit', commitMessage.trim())}
              >
                {branchAction.isPending ? 'Committing…' : actionLabels.commit}
              </Button>
            </div>
          </div>
        )}

        {hasActions && (
          <div className="flex flex-wrap gap-2 border-t border-border/60 pt-2">
            {showIntegrate && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex">
                      <Button
                        variant="primary"
                        disabled={branchAction.isPending}
                        onClick={() => handleAction('integrate')}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Merge in {parent}
                      </Button>
                    </span>
                  }
                />
                <TooltipContent>
                  This will merge the {parent} branch into the working branch
                </TooltipContent>
              </Tooltip>
            )}
            {showPushParent && (
              <Button
                variant="primary"
                disabled={branchAction.isPending}
                onClick={() => handleAction('push_parent')}
              >
                <ArrowUp className="h-3.5 w-3.5" />
                Push {parent}
              </Button>
            )}
            {showPublish && (
              <Button
                variant="secondary"
                disabled={branchAction.isPending}
                onClick={() => handleAction('publish')}
              >
                <ArrowUp className="h-3.5 w-3.5" />
                Publish
              </Button>
            )}
          </div>
        )}

        {showCreatePr && (
          <div className="space-y-1.5 border-t border-border/60 pt-2">
            <p className="text-xs text-muted-foreground">Open a pull request:</p>
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-[0.7rem] text-muted-foreground">
                {prCommand}
              </code>
              <CopyIconButton value={prCommand} label="Copy PR command" />
            </div>
          </div>
        )}

        {confirmAction && (
          <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
            <p className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                An objective is currently executing on this branch. Continuing may conflict with
                in-progress work in its worktree. Continue anyway?
              </span>
            </p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                disabled={branchAction.isPending}
                onClick={() =>
                  void runAction(
                    confirmAction,
                    true,
                    confirmAction === 'commit' ? commitMessage.trim() : undefined
                  )
                }
              >
                Continue anyway
              </Button>
              <Button
                variant="ghost"
                disabled={branchAction.isPending}
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {actionError && <p className="text-xs text-destructive">{actionError}</p>}
      </div>
    </TooltipProvider>
  );
}

/**
 * The header git control: a compact one-liner showing the branch name (truncated)
 * fronted by a status icon. Clicking it opens a popover with the full branch
 * panel — the same status, identity, and lifecycle actions that used to live in
 * the mission body. Renders nothing until the mission has a branch.
 */
export function MissionBranchControl({ mission }: { mission: MissionDetailDto }) {
  const branch = mission.branch;
  if (!branch) return null;

  const status = BRANCH_STATUS_META[branch.status];
  const StatusIcon = status.icon;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Git branch: ${branch.name} (${status.label})`}
            title={`${branch.name} · ${status.label}`}
            className="flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-transparent px-2 text-xs hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', status.accent)} />
        <code className="min-w-0 truncate font-medium">{branch.name}</code>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-3">
        <BranchPanel mission={mission} />
      </PopoverContent>
    </Popover>
  );
}
