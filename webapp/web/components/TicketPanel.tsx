import { deriveObjectiveLifecycleView, objectiveHasInstructionText } from '@overlord/automations';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRightToLine, Check, Copy, Loader2, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';

import type { TicketDetailDto } from '../../shared/contract.ts';
import {
  useCreateObjective,
  useGenerateTicketTitle,
  useTicket,
  useUpdateTicket
} from '../lib/queries.ts';
import { cn } from '../lib/utils.ts';

import { TicketObjectivesSection } from './objectives/TicketObjectivesSection.tsx';
import { Button as IconButton } from './ui/button.tsx';
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

function BranchSection({ ticket }: { ticket: TicketDetailDto }) {
  const branch = ticket.branch;
  if (!branch) return null;
  const statusLabel =
    branch.status === 'pending'
      ? 'not created yet'
      : branch.status === 'merged'
        ? 'merged'
        : 'active';
  const statusClass =
    branch.status === 'pending'
      ? 'bg-muted text-muted-foreground'
      : branch.status === 'merged'
        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : 'bg-sky-500/10 text-sky-700 dark:text-sky-300';
  const cdCommand = branch.worktreePath ? `cd ${JSON.stringify(branch.worktreePath)}` : null;

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
          {branch.worktreePath && (
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {branch.worktreePath}
              </code>
              <CopyIconButton value={branch.worktreePath} label="Copy path" />
              {cdCommand && <CopyIconButton value={cdCommand} label="Copy cd command" />}
            </div>
          )}
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
