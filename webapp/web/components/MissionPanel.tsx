import { deriveObjectiveLifecycleView, objectiveHasInstructionText } from '@overlord/automations';
import { useNavigate } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowRightToLine,
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  GitBranch,
  Loader2,
  RefreshCw,
  Sparkles,
  Terminal
} from 'lucide-react';
import { useRef, useState } from 'react';

import type {
  MissionBranchDto,
  MissionBranchStatus,
  MissionDetailDto
} from '../../shared/contract.ts';
import { ApiRequestError } from '../lib/api.ts';
import {
  useBranchAction,
  useCreateObjective,
  useGenerateMissionTitle,
  useMission,
  useMissionBranches,
  useUpdateMission
} from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';

import { MissionObjectivesSection } from './objectives/MissionObjectivesSection.tsx';
import { Button as IconButton } from './ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu.tsx';
import { Separator } from './ui/separator.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';
import { InlineEditField } from './InlineEditField.tsx';
import { LiveActivityFeed } from './LiveActivityFeed.tsx';
import { LiveFileChanges } from './LiveFileChanges.tsx';
import { MissionArtifactsSection } from './MissionArtifactsSection.tsx';
import { MissionPanelHeader } from './MissionPanelHeader.tsx';
import { MissionToolsAndCriteria } from './MissionToolsAndCriteria.tsx';
import { Button, Spinner } from './ui.tsx';

/**
 * Adds a new objective by creating a blank editable slot rather than opening a
 * separate composer. The slot renders directly as a {@link MissionObjectivesSection}
 * `DraftObjective` card for inline authoring (with `@`/`#`/`$` mentions). The
 * server promotes it to `future` automatically when a draft already exists, so a
 * draft is always the next-up slot and extra slots queue behind it. The button
 * disables while a blank slot already awaits input to avoid stacking empties.
 */
function AddObjective({ mission }: { mission: MissionDetailDto }) {
  const create = useCreateObjective();
  const lifecycleView = deriveObjectiveLifecycleView(mission.objectives);

  const hasBlankSlot = [
    ...lifecycleView.editableObjectives,
    ...lifecycleView.futureObjectives
  ].some(objective => !objectiveHasInstructionText(objective));
  const disabled = hasBlankSlot || create.isPending;

  const addObjective = () => {
    if (disabled) return;
    create.mutate({ missionId: mission.id, instructionText: '', state: 'draft' });
  };

  return (
    <div className="space-y-1">
      <Button variant="secondary" onClick={addObjective} disabled={disabled}>
        {create.isPending ? 'Adding…' : '+ Add objective'}
      </Button>
      {create.isError && <p className="text-xs text-red-400">{(create.error as Error).message}</p>}
    </div>
  );
}

/** Generates the mission title from its primary objective via the Automations Layer summarizer. */
function GenerateMissionTitleButton({ mission }: { mission: MissionDetailDto }) {
  const generate = useGenerateMissionTitle(mission.id);
  const [justSucceeded, setJustSucceeded] = useState(false);
  const hasObjectiveText = mission.objectives.some(
    objective => objective.instructionText.trim().length > 0
  );
  const disabled = generate.isPending || !hasObjectiveText;

  const handleClick = () => {
    if (disabled) return;
    generate.mutate(undefined, {
      onSuccess: () => {
        setJustSucceeded(true);
        window.setTimeout(() => setJustSucceeded(false), 1200);
      }
    });
  };

  const label = !hasObjectiveText
    ? 'Add an objective before generating a title'
    : generate.isError
      ? (generate.error as Error).message
      : 'Generate title with AI';

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Generate title with AI"
            disabled={disabled}
            onClick={handleClick}
          />
        }
      >
        {generate.isPending ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <Sparkles
            className={cn(
              'h-5 w-5',
              justSucceeded && 'text-emerald-600',
              generate.isError && 'text-destructive'
            )}
          />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function MissionTitle({ mission }: { mission: MissionDetailDto }) {
  const update = useUpdateMission(mission.id);

  return (
    <section className="border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-3">
      <h1 className="flex items-center gap-1 text-base font-semibold leading-snug">
        <InlineEditField
          className="min-w-0 flex-1"
          value={mission.title}
          ariaLabel="Mission title"
          onSave={title => update.mutate({ title })}
        />
        <GenerateMissionTitleButton mission={mission} />
      </h1>
    </section>
  );
}

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

type BranchActionName = 'integrate' | 'commit' | 'push_parent' | 'publish';

// Sentinel for the "Automatic" choice — mapped to clearing the override
// (branchOverride: null) rather than pinning a named branch.
const AUTO_BRANCH = '__auto__';

// Visual treatment per branch lifecycle state. A colored dot is the primary
// indicator (scannable at a glance); the tinted pill reinforces it. Kept as a
// lookup table rather than nested ternaries so the states read as a set.
const BRANCH_STATUS_META: Record<
  MissionBranchStatus,
  { label: string; dot: string; pill: string }
> = {
  pending: {
    label: 'Not created',
    dot: 'bg-muted-foreground/40',
    pill: 'bg-muted text-muted-foreground'
  },
  created: {
    label: 'Created',
    dot: 'bg-sky-500',
    pill: 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
  },
  published: {
    label: 'Published',
    dot: 'bg-violet-500',
    pill: 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
  },
  merged_unpushed: {
    label: 'Merged · unpushed',
    dot: 'bg-amber-500',
    pill: 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
  },
  merged: {
    label: 'Merged',
    dot: 'bg-emerald-500',
    pill: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
};

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

function BranchSection({ mission }: { mission: MissionDetailDto }) {
  const branch = mission.branch;
  const branchAction = useBranchAction(mission.id);
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
      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
          Branch
        </h2>
        <div className="space-y-3 rounded-md border border-border bg-background/60 p-3 text-sm">
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
            <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
              <p className="text-xs text-amber-800 dark:text-amber-200">
                This branch has uncommitted changes. Commit them before updating from {parent}.
              </p>
              <input
                type="text"
                value={commitMessage}
                onChange={event => setCommitMessage(event.target.value)}
                placeholder="Commit message"
                aria-label="Commit message"
                disabled={branchAction.isPending}
                onKeyDown={event => {
                  if (event.key === 'Enter' && commitMessageValid && !branchAction.isPending) {
                    handleAction('commit', commitMessage.trim());
                  }
                }}
                className="h-7 w-full rounded-md border bg-transparent px-2 text-xs"
              />
              <Button
                variant="primary"
                disabled={branchAction.isPending || !commitMessageValid}
                onClick={() => handleAction('commit', commitMessage.trim())}
              >
                {branchAction.isPending ? 'Committing…' : actionLabels.commit}
              </Button>
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
      </div>
    </TooltipProvider>
  );
}

export function MissionPanel({
  projectId,
  missionId,
  onClose,
  onProjectChanged
}: {
  projectId: string;
  missionId: string;
  /** Override the default close-to-project-board navigation (e.g. My Missions → /workspace). */
  onClose?: () => void;
  /** Override the default navigation after a cross-project move. */
  onProjectChanged?: (nextProjectId: string) => void;
}) {
  const navigate = useNavigate();
  const missionQ = useMission(missionId, { refetchBranchState: true });
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleScroll = () => {
    setIsScrolling(true);
    clearTimeout(scrollIdleTimeoutRef.current);
    scrollIdleTimeoutRef.current = setTimeout(() => setIsScrolling(false), 800);
  };

  const handleProjectChanged = (nextProjectId: string) => {
    if (onProjectChanged) {
      onProjectChanged(nextProjectId);
      return;
    }
    navigate({
      to: '/projects/$projectId/missions/$missionId',
      params: { projectId: nextProjectId, missionId }
    });
  };

  const closeToProject = (targetProjectId: string) => {
    if (onClose) {
      onClose();
      return;
    }
    navigate({ to: '/projects/$projectId', params: { projectId: targetProjectId } });
  };

  if (missionQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Spinner />
      </div>
    );
  }

  if (missionQ.isError || !missionQ.data) {
    return (
      <div className="flex h-full flex-col p-4">
        <div className="mb-3">
          <Button
            variant="ghost"
            aria-label="Close mission panel"
            onClick={() => closeToProject(projectId)}
          >
            <ArrowRightToLine className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-sm text-red-400">
          Could not load mission: {(missionQ.error as Error)?.message ?? 'not found'}
        </p>
      </div>
    );
  }

  const mission = missionQ.data;

  return (
    <div className="flex h-full min-h-0 min-w-[375px] flex-col bg-(--color-surface-1)">
      <MissionPanelHeader
        mission={mission}
        projectId={mission.projectId}
        onClose={() => closeToProject(mission.projectId)}
        onProjectChanged={handleProjectChanged}
      />
      <MissionTitle mission={mission} />

      <div
        className={cn(
          'scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-muted',
          isScrolling && 'is-scrolling'
        )}
        onScroll={handleScroll}
      >
        {/* Card section — primary work surface: objectives */}
        <section className="border-b border-(--color-border) bg-(--color-surface-1) py-5">
          <div className="mb-3 px-5"></div>
          <div className="flex flex-col gap-3 px-5 pb-1">
            <MissionObjectivesSection mission={mission} />
            <AddObjective mission={mission} />
          </div>
        </section>

        {/* Subtle section — supporting context: tools and activity */}
        <section className="flex flex-col px-5 pt-5 bg-muted h-full pb-10">
          <MissionToolsAndCriteria
            missionId={mission.id}
            availableTools={mission.availableTools}
            acceptanceCriteria={mission.acceptanceCriteria}
          />
          <Separator />
          <div className="flex flex-col gap-6 mt-8">
            <BranchSection mission={mission} />
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-dim)">
                Activity
              </h2>
              <LiveActivityFeed missionId={mission.id} />
            </div>
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-dim)">
                Artifacts
              </h2>
              <MissionArtifactsSection missionId={mission.id} />
            </div>
            <div className="space-y-3 pb-5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-dim)">
                File Changes
              </h2>
              <LiveFileChanges missionId={mission.id} projectId={mission.projectId} />
            </div>{' '}
          </div>
        </section>
      </div>
    </div>
  );
}
