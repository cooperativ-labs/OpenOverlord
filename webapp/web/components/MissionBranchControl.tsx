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
import { useMemo, useState } from 'react';

import type {
  MissionBranchDto,
  MissionBranchStatus,
  MissionDetailDto
} from '../../shared/contract.ts';
import { LocalTargetRequiredNotice } from './LocalTargetRequiredNotice.tsx';
import { ApiRequestError } from '../lib/api.ts';
import {
  resolvePrimaryResourceForTarget,
  useObservedMissionBranch
} from '../lib/local-target-branch.ts';
import {
  hasPendingLocalTargetMutation,
  useIsRemoteExecutionTargetForProject
} from '../lib/local-target-remote.ts';
import { useLocalTargetUnavailable } from '../lib/local-target-client.ts';
import {
  useBranchAction,
  useGenerateCommitMessage,
  useMissionBranches,
  useProjectExecutionTarget,
  useProjectResources,
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
import { Label } from './ui/label.tsx';
import { LoadingButton } from './ui/loading-button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx';
import { Switch } from './ui/switch.tsx';
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
  const localTargetUnavailable = useLocalTargetUnavailable();
  const branches = useMissionBranches({
    missionId: mission.id,
    projectId: mission.projectId,
    current: mission.branch?.overrideBranch ?? mission.branch?.name ?? null,
    enabled: open
  });
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
            {localTargetUnavailable && options.length === 0 && !branches.isLoading && (
              <DropdownMenuItem disabled>
                <LocalTargetRequiredNotice />
              </DropdownMenuItem>
            )}
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
 * Shown when a mission would run directly off its base branch — i.e. worktree
 * automation is off (workspace-wide) and the mission has no per-mission opt-in
 * (coo:9). Lets the user opt this single mission into a dedicated branch, with a
 * checkbox choosing whether that branch gets its own worktree (default on). The
 * choice is persisted as the mission's `worktreePreference`; the runner prepares
 * the branch/worktree at the mission's next launch — no git side-effects here.
 */
function CreateBranchForm({ mission }: { mission: MissionDetailDto }) {
  const branch = mission.branch;
  const update = useUpdateMission(mission.id);
  const [useWorktree, setUseWorktree] = useState(true);

  if (!branch) return null;
  const base = branch.baseBranch ?? 'main';

  return (
    <div className="space-y-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs text-muted-foreground">From</span>
        <code className="min-w-0 flex-1 truncate text-[0.8rem] font-medium" title={base}>
          {base}
        </code>
      </div>

      <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-2.5">
        <p className="text-xs text-muted-foreground">
          Create a dedicated branch for this mission. Overlord prepares it the next time the mission
          runs, then follows the usual branch workflow.
        </p>
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <GitBranchPlus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <code className="min-w-0 flex-1 truncate text-[0.75rem] font-medium" title={branch.name}>
            {branch.name}
          </code>
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="create-in-worktree" className="text-xs font-normal">
            Create in a worktree
          </Label>
          <Switch
            id="create-in-worktree"
            checked={useWorktree}
            disabled={update.isPending}
            onCheckedChange={setUseWorktree}
          />
        </div>
        <Button
          variant="primary"
          className="w-full justify-center"
          disabled={update.isPending}
          onClick={() => update.mutate({ worktreePreference: useWorktree ? 'worktree' : 'branch' })}
        >
          <GitBranchPlus className="h-3.5 w-3.5" />
          {update.isPending ? 'Creating…' : 'Create branch'}
        </Button>
      </div>
      {update.isError && (
        <p className="text-xs text-destructive">{(update.error as Error).message}</p>
      )}
    </div>
  );
}

// A branch-action failure, reshaped for display: a short title, one clear
// instruction, and optional factual specifics (paths, conflicting files).
interface BranchErrorView {
  title: string;
  instruction: string;
  detail?: string;
}

/**
 * Turns a raw branch-action error into a short title + plain-language instruction
 * the user can act on, instead of a single run-on red sentence. Common typed
 * failures (merge conflicts, a dirty worktree, a failed push) each get tailored
 * guidance; the server's `detail` (worktree path, conflicting files) rides along
 * as secondary context. Anything unrecognized falls back to the server message.
 */
function describeBranchError(err: unknown, parent: string): BranchErrorView {
  if (!(err instanceof ApiRequestError)) {
    return {
      title: 'Branch action failed',
      instruction: err instanceof Error ? err.message : 'Something went wrong. Please try again.'
    };
  }
  switch (err.code) {
    case 'BRANCH_MERGE_CONFLICT':
      return {
        title: 'Merge conflicts need resolving',
        instruction: `Open the branch's worktree, resolve the conflicting files, commit them, then run "Merge in ${parent}" again.`,
        detail: err.detail
      };
    case 'BRANCH_DIRTY':
      return {
        title: 'Uncommitted changes',
        instruction: 'Commit or discard the changes in the worktree, then try again.',
        detail: err.detail
      };
    case 'BRANCH_NOTHING_TO_COMMIT':
      return {
        title: 'Nothing to commit',
        instruction: 'The branch worktree has no changes to commit.',
        detail: err.detail
      };
    case 'BRANCH_PARENT_NOT_CHECKED_OUT':
      return {
        title: `${parent} isn't checked out`,
        instruction: `Check out ${parent} in the primary working directory, then try again.`,
        detail: err.detail
      };
    case 'BRANCH_PUSH_FAILED':
      return {
        title: 'Push to origin failed',
        instruction: 'Check your network and git remote credentials, then try again.',
        detail: err.detail
      };
    case 'BRANCH_NO_WORKTREE':
    case 'BRANCH_WORKTREE_MISMATCH':
      return {
        title: 'Worktree unavailable',
        instruction: 'The branch worktree is missing or on the wrong branch.',
        detail: err.detail
      };
    case 'BRANCH_NO_PRIMARY':
      return {
        title: 'No working directory',
        instruction:
          'Connect a primary working directory for this project on this device, then try again.',
        detail: err.detail
      };
    case 'LOCAL_TARGET_REQUIRED':
      return {
        title: 'Desktop required',
        instruction:
          'Open Overlord Desktop on this machine to run git branch actions against linked checkouts.',
        detail: err.detail
      };
    default:
      // Unrecognized: the merged server message is the best we have.
      return { title: 'Branch action failed', instruction: err.message };
  }
}

/**
 * The full git control surface for a mission's branch: status, identity, and the
 * lifecycle actions (commit, merge in parent, push, publish, open a PR). Rendered
 * inside the header popover; its layout assumes the surrounding popover supplies
 * the padding and surface.
 */
function BranchPanel({ mission }: { mission: MissionDetailDto }) {
  const branch = mission.branch;
  const localTargetUnavailable = useLocalTargetUnavailable();
  const isRemoteTarget = useIsRemoteExecutionTargetForProject(mission.projectId);
  const pendingMutation = hasPendingLocalTargetMutation(mission.executionRequests);
  const branchAction = useBranchAction(mission);
  const generateCommitMessage = useGenerateCommitMessage(mission);
  const update = useUpdateMission(mission.id);
  const [actionError, setActionError] = useState<BranchErrorView | null>(null);
  // When an action needs confirmation (an objective is executing on the branch),
  // we stash the intended action and surface an inline confirm prompt.
  const [confirmAction, setConfirmAction] = useState<BranchActionName | null>(null);
  // The commit message captured before merging, while the branch worktree is dirty.
  const [commitMessage, setCommitMessage] = useState('');

  if (!branch) return null;
  // Worktree automation is off for this mission and it hasn't been opted in, so it
  // runs off the base branch: offer the per-mission create-branch affordance.
  if (!branch.willPrepareBranch) return <CreateBranchForm mission={mission} />;
  const status = BRANCH_STATUS_META[branch.status];
  // A per-mission opt-in that hasn't been prepared yet can still be reverted to
  // "work off the base branch" (only meaningful while automation is globally off).
  const canRevertToBase =
    !branch.worktreeAutomationEnabled &&
    branch.worktreePreference !== null &&
    branch.status === 'pending';

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
      setActionError(describeBranchError(err, parent));
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
  const gitUnavailable =
    (localTargetUnavailable && !isRemoteTarget && branch.status !== 'pending') || pendingMutation;
  const hasActions = (showIntegrate || showPushParent || showPublish) && !gitUnavailable;

  return (
    <TooltipProvider>
      <div className="space-y-3 text-sm">
        {pendingMutation && (
          <p className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs text-muted-foreground">
            A branch action is queued on the selected execution target. It will finish when that
            device&apos;s runner claims the job.
          </p>
        )}
        {isRemoteTarget && !localTargetUnavailable && branch.status !== 'pending' && (
          <p className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs text-muted-foreground">
            Branch actions queue on the selected remote execution target and run when its runner
            is online.
          </p>
        )}
        {localTargetUnavailable && !isRemoteTarget && branch.status !== 'pending' && (
          <LocalTargetRequiredNotice className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs text-muted-foreground" />
        )}
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
          {branch.worktreePreference !== null && (
            <p className="pl-6 text-[0.7rem] text-muted-foreground">
              Per-mission {branch.worktreePreference === 'worktree' ? 'worktree' : 'branch'}{' '}
              (workspace automation is off)
            </p>
          )}
        </div>

        {canRevertToBase && (
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate({ worktreePreference: null })}
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
          >
            Cancel — work off {parent} instead
          </button>
        )}

        {showCommit && !gitUnavailable && (
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
              <LoadingButton
                variant="default"
                buttonState={branchAction.isPending ? 'loading' : 'default'}
                onClick={() => handleAction('push_parent')}
                text={
                  <>
                    <ArrowUp className="h-3.5 w-3.5" />
                    Push {parent}
                  </>
                }
                loadingText={`Push ${parent}`}
              />
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

        {actionError && (
          <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/10 p-2.5">
            <p className="flex items-start gap-1.5 text-xs font-medium text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{actionError.title}</span>
            </p>
            <p className="pl-5 text-xs text-destructive/90">{actionError.instruction}</p>
            {actionError.detail && (
              <p className="break-words pl-5 font-mono text-[0.7rem] text-muted-foreground">
                {actionError.detail}
              </p>
            )}
          </div>
        )}
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
  const executionTarget = useProjectExecutionTarget(mission.projectId);
  const resources = useProjectResources(mission.projectId);
  const selectedExecutionTargetId = executionTarget.data?.selectedExecutionTargetId ?? null;
  const primaryResource = useMemo(
    () =>
      resolvePrimaryResourceForTarget({
        resources: resources.data ?? [],
        executionTargetId: selectedExecutionTargetId
      }),
    [resources.data, selectedExecutionTargetId]
  );
  const observedBranch = useObservedMissionBranch({
    mission,
    resource: primaryResource,
    executionTargetId: selectedExecutionTargetId ?? primaryResource?.executionTargetId ?? null,
    enabled: true
  });
  const displayMission = useMemo<MissionDetailDto>(
    () =>
      observedBranch.data
        ? { ...mission, branch: observedBranch.data }
        : mission,
    [mission, observedBranch.data]
  );
  const branch = displayMission.branch;
  if (!branch) return null;

  // When the mission will run off its base branch (worktree automation off and no
  // per-mission opt-in), the control reads "<base>" with a muted
  // treatment; the popover then offers the create-branch affordance (coo:9).
  const workingOffBase = !branch.willPrepareBranch;
  const base = branch.baseBranch ?? 'main';
  const status = BRANCH_STATUS_META[branch.status];
  const StatusIcon = workingOffBase ? GitBranch : status.icon;
  const label = workingOffBase ? base : branch.name;
  const title = workingOffBase ? `${base}` : `${branch.name} · ${status.label}`;
  const ariaLabel = workingOffBase
    ? `Git: working off ${base}`
    : `Git branch: ${branch.name} (${status.label})`;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel}
            title={title}
            className="flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-transparent px-2 text-xs hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <StatusIcon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            workingOffBase ? 'text-muted-foreground' : status.accent
          )}
        />
        <code className="min-w-0 truncate font-medium">{label}</code>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-80 p-3">
        <BranchPanel mission={displayMission} />
      </PopoverContent>
    </Popover>
  );
}
