import { deriveObjectiveLifecycleView, objectiveHasInstructionText } from '@overlord/automations';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRightToLine, Check, Copy, Loader2, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';

import type { TicketDetailDto } from '../../shared/contract.ts';
import { ApiRequestError } from '../lib/api.ts';
import {
  useBranchAction,
  useCreateObjective,
  useGenerateTicketTitle,
  useTicket,
  useTicketBranches,
  useUpdateTicket
} from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';

import { TicketObjectivesSection } from './objectives/TicketObjectivesSection.tsx';
import { Button as IconButton } from './ui/button.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx';
import { Separator } from './ui/separator.tsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip.tsx';
import { InlineEditField } from './InlineEditField.tsx';
import { LiveActivityFeed } from './LiveActivityFeed.tsx';
import { LiveFileChanges } from './LiveFileChanges.tsx';
import { TicketArtifactsSection } from './TicketArtifactsSection.tsx';
import { TicketPanelHeader } from './TicketPanelHeader.tsx';
import { TicketToolsAndCriteria } from './TicketToolsAndCriteria.tsx';
import { Button, Spinner } from './ui.tsx';

/**
 * Adds a new objective by creating a blank editable slot rather than opening a
 * separate composer. The slot renders directly as a {@link TicketObjectivesSection}
 * `DraftObjective` card for inline authoring (with `@`/`#`/`$` mentions). The
 * server promotes it to `future` automatically when a draft already exists, so a
 * draft is always the next-up slot and extra slots queue behind it. The button
 * disables while a blank slot already awaits input to avoid stacking empties.
 */
function AddObjective({ ticket }: { ticket: TicketDetailDto }) {
  const create = useCreateObjective();
  const lifecycleView = deriveObjectiveLifecycleView(ticket.objectives);

  const hasBlankSlot = [
    ...lifecycleView.editableObjectives,
    ...lifecycleView.futureObjectives
  ].some(objective => !objectiveHasInstructionText(objective));
  const disabled = hasBlankSlot || create.isPending;

  const addObjective = () => {
    if (disabled) return;
    create.mutate({ ticketId: ticket.id, instructionText: '', state: 'draft' });
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

/** Generates the ticket title from its primary objective via the Automations Layer summarizer. */
function GenerateTicketTitleButton({ ticket }: { ticket: TicketDetailDto }) {
  const generate = useGenerateTicketTitle(ticket.id);
  const [justSucceeded, setJustSucceeded] = useState(false);
  const hasObjectiveText = ticket.objectives.some(
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
            size="icon-xs"
            aria-label="Generate title with AI"
            disabled={disabled}
            onClick={handleClick}
          />
        }
      >
        {generate.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles
            className={cn(
              'h-3.5 w-3.5',
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

function TicketTitle({ ticket }: { ticket: TicketDetailDto }) {
  const update = useUpdateTicket(ticket.id);

  return (
    <section className="border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-3">
      <h1 className="flex items-center gap-1 text-base font-semibold leading-snug">
        <InlineEditField
          className="min-w-0 flex-1"
          value={ticket.title}
          ariaLabel="Ticket title"
          onSave={title => update.mutate({ title })}
        />
        <GenerateTicketTitleButton ticket={ticket} />
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

type BranchActionName = 'integrate' | 'push_parent' | 'publish';

// Sentinel for the "Automatic" choice — Radix Select items cannot use an empty
// string value, so we map this to clearing the override (branchOverride: null).
const AUTO_BRANCH = '__auto__';

/**
 * Lets the user pin a different branch when the system-chosen default is wrong.
 * The choice is stored as the ticket's `branchOverride` and consumed by the
 * runner at the next launch (no git side-effects here). Branches are fetched
 * lazily — only once the selector is opened.
 */
function BranchSelector({ ticket }: { ticket: TicketDetailDto }) {
  const [open, setOpen] = useState(false);
  const branches = useTicketBranches(ticket.id, open);
  const update = useUpdateTicket(ticket.id);
  const override = ticket.branch?.overrideBranch ?? null;

  function handleChange(value: string | null): void {
    if (!value) return;
    update.mutate({ branchOverride: value === AUTO_BRANCH ? null : value });
  }

  const options = branches.data?.branches ?? [];

  return (
    <div className="space-y-1">
      {!open ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setOpen(true)}
        >
          {override ? `Pinned to ${override} — change` : 'Use a different branch'}
        </button>
      ) : (
        <Select
          value={override ?? AUTO_BRANCH}
          disabled={update.isPending || branches.isLoading}
          onValueChange={handleChange}
        >
          <SelectTrigger
            id={`branch-select-${ticket.id}`}
            aria-label="Select branch"
            size="sm"
            className="h-7 w-full rounded-md border bg-transparent px-2 text-xs"
          >
            <SelectValue>
              {branches.isLoading
                ? 'Loading branches…'
                : (override ?? 'Automatic (system default)')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_BRANCH}>Automatic (system default)</SelectItem>
            {options.map(name => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {update.isError && (
        <p className="text-xs text-destructive">{(update.error as Error).message}</p>
      )}
    </div>
  );
}

function BranchSection({ ticket }: { ticket: TicketDetailDto }) {
  const branch = ticket.branch;
  const branchAction = useBranchAction(ticket.id);
  const [actionError, setActionError] = useState<string | null>(null);
  // When an action needs confirmation (an objective is executing on the branch),
  // we stash the intended action and surface an inline confirm prompt.
  const [confirmAction, setConfirmAction] = useState<BranchActionName | null>(null);

  if (!branch) return null;
  const statusLabel =
    branch.status === 'pending'
      ? 'not created yet'
      : branch.status === 'created'
        ? 'created'
        : branch.status === 'published'
          ? 'published'
          : branch.status === 'merged_unpushed'
            ? 'merged · unpushed'
            : 'merged';
  const statusClass =
    branch.status === 'pending'
      ? 'bg-muted text-muted-foreground'
      : branch.status === 'created'
        ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
        : branch.status === 'published'
          ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
          : branch.status === 'merged_unpushed'
            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
            : 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  const cdCommand = branch.worktreePath ? `cd ${JSON.stringify(branch.worktreePath)}` : null;

  const parent = branch.baseBranch ?? 'main';
  // A GitHub PR can only target a pushed branch, so this is offered on `published`.
  const prCommand = `gh pr create --base ${parent} --head ${branch.name} --fill --web`;
  // The DTO carries only the active (queued/claimed/launching) execution requests.
  const isExecuting = ticket.executionRequests.length > 0;
  const actionLabels: Record<BranchActionName, string> = {
    integrate: `Update from ${parent} & merge`,
    push_parent: `Push ${parent}`,
    publish: 'Publish'
  };

  async function runAction(action: BranchActionName, confirmBusy: boolean): Promise<void> {
    setActionError(null);
    try {
      await branchAction.mutateAsync({ action, confirmBusy });
      setConfirmAction(null);
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

  function handleAction(action: BranchActionName): void {
    if (isExecuting) {
      setActionError(null);
      setConfirmAction(action);
      return;
    }
    void runAction(action, false);
  }

  const showIntegrate = branch.status === 'created' || branch.status === 'published';
  const showPushParent = branch.status === 'merged_unpushed';
  const showPublish = branch.status === 'created';
  const showCreatePr = branch.status === 'published';
  const hasActions = showIntegrate || showPushParent || showPublish || showCreatePr;

  return (
    <TooltipProvider>
      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
          Branch
        </h2>
        <div className="space-y-2 rounded-md border border-border bg-background/60 p-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-xs">{branch.name}</code>
            <CopyIconButton value={branch.name} label="Copy branch" />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className={`rounded-full px-2 py-0.5 font-medium ${statusClass}`}>
              {statusLabel}
            </span>
            {branch.baseBranch && <span>cut from {branch.baseBranch}</span>}
          </div>
          <BranchSelector ticket={ticket} />
          {branch.worktreePath && (
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {branch.worktreePath}
              </code>
              <CopyIconButton value={branch.worktreePath} label="Copy path" />
              {cdCommand && <CopyIconButton value={cdCommand} label="Copy cd command" />}
            </div>
          )}

          {hasActions && (
            <div className="flex flex-wrap gap-2 pt-1">
              {showIntegrate && (
                <Button
                  variant="primary"
                  disabled={branchAction.isPending}
                  onClick={() => handleAction('integrate')}
                >
                  {actionLabels.integrate}
                </Button>
              )}
              {showPushParent && (
                <Button
                  variant="primary"
                  disabled={branchAction.isPending}
                  onClick={() => handleAction('push_parent')}
                >
                  {actionLabels.push_parent}
                </Button>
              )}
              {showPublish && (
                <Button
                  variant="secondary"
                  disabled={branchAction.isPending}
                  onClick={() => handleAction('publish')}
                >
                  {actionLabels.publish}
                </Button>
              )}
            </div>
          )}

          {showCreatePr && (
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {prCommand}
              </code>
              <CopyIconButton value={prCommand} label="Copy PR command" />
            </div>
          )}

          {confirmAction && (
            <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
              <p>
                An objective is currently executing on this branch. Continuing may conflict with
                in-progress work in its worktree. Continue anyway?
              </p>
              <div className="flex gap-2">
                <Button
                  variant="danger"
                  disabled={branchAction.isPending}
                  onClick={() => void runAction(confirmAction, true)}
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

export function TicketPanel({
  projectId,
  ticketId,
  onClose,
  onProjectChanged
}: {
  projectId: string;
  ticketId: string;
  /** Override the default close-to-project-board navigation (e.g. My Tickets → /workspace). */
  onClose?: () => void;
  /** Override the default navigation after a cross-project move. */
  onProjectChanged?: (nextProjectId: string) => void;
}) {
  const navigate = useNavigate();
  const ticketQ = useTicket(ticketId);
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
      to: '/projects/$projectId/tickets/$ticketId',
      params: { projectId: nextProjectId, ticketId }
    });
  };

  const closeToProject = (targetProjectId: string) => {
    if (onClose) {
      onClose();
      return;
    }
    navigate({ to: '/projects/$projectId', params: { projectId: targetProjectId } });
  };

  if (ticketQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Spinner />
      </div>
    );
  }

  if (ticketQ.isError || !ticketQ.data) {
    return (
      <div className="flex h-full flex-col p-4">
        <div className="mb-3">
          <Button
            variant="ghost"
            aria-label="Close ticket panel"
            onClick={() => closeToProject(projectId)}
          >
            <ArrowRightToLine className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-sm text-red-400">
          Could not load ticket: {(ticketQ.error as Error)?.message ?? 'not found'}
        </p>
      </div>
    );
  }

  const ticket = ticketQ.data;

  return (
    <div className="flex h-full min-h-0 min-w-[375px] flex-col bg-(--color-surface-1)">
      <TicketPanelHeader
        ticket={ticket}
        projectId={ticket.projectId}
        onClose={() => closeToProject(ticket.projectId)}
        onProjectChanged={handleProjectChanged}
      />
      <TicketTitle ticket={ticket} />

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
            <TicketObjectivesSection ticket={ticket} />
            <AddObjective ticket={ticket} />
          </div>
        </section>

        {/* Subtle section — supporting context: tools and activity */}
        <section className="flex flex-col px-5 pt-5 bg-muted h-full pb-10">
          <TicketToolsAndCriteria
            ticketId={ticket.id}
            availableTools={ticket.availableTools}
            acceptanceCriteria={ticket.acceptanceCriteria}
          />
          <Separator />
          <div className="flex flex-col gap-6 mt-8">
            <BranchSection ticket={ticket} />
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-dim)">
                Activity
              </h2>
              <LiveActivityFeed ticketId={ticket.id} />
            </div>
            <div className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-dim)">
                Artifacts
              </h2>
              <TicketArtifactsSection ticketId={ticket.id} />
            </div>
            <div className="space-y-3 pb-5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-(--color-ink-dim)">
                File Changes
              </h2>
              <LiveFileChanges ticketId={ticket.id} projectId={ticket.projectId} />
            </div>{' '}
          </div>
        </section>
      </div>
    </div>
  );
}
