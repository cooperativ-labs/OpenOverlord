import { useNavigate } from '@tanstack/react-router';
import { ArrowRightToLine } from 'lucide-react';
import { useState } from 'react';

import type { TicketDetailDto } from '../../shared/contract.ts';
import { useCreateObjective, useTicket, useUpdateTicket } from '../lib/queries.ts';

import { TicketObjectivesSection } from './objectives/TicketObjectivesSection.tsx';
import { InlineEditField } from './InlineEditField.tsx';
import { LiveActivityFeed } from './LiveActivityFeed.tsx';
import { LiveFileChanges } from './LiveFileChanges.tsx';
import { RepositoryMentionTextarea } from './RepositoryMentionTextarea.tsx';
import { TicketArtifactsSection } from './TicketArtifactsSection.tsx';
import { TicketPanelHeader } from './TicketPanelHeader.tsx';
import { TicketToolsAndCriteria } from './TicketToolsAndCriteria.tsx';
import { Button, Card, Field, Spinner } from './ui.tsx';

function AddObjective({ ticketId, projectId }: { ticketId: string; projectId: string }) {
  const create = useCreateObjective();
  const [instruction, setInstruction] = useState('');
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        + Add objective
      </Button>
    );
  }

  const submit = () => {
    if (!instruction.trim()) return;
    create.mutate(
      { ticketId, instructionText: instruction.trim() },
      {
        onSuccess: () => {
          setInstruction('');
          setOpen(false);
        }
      }
    );
  };

  return (
    <Card className="space-y-3 p-3">
      <Field label="New objective instruction">
        <RepositoryMentionTextarea
          autoFocus
          rows={3}
          projectId={projectId}
          value={instruction}
          placeholder="Describe what the agent should do… (@ file, # project, $ ticket)"
          onValueChange={setInstruction}
        />
      </Field>
      {create.isError && <p className="text-xs text-red-400">{(create.error as Error).message}</p>}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setInstruction('');
          }}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={submit}
          disabled={!instruction.trim() || create.isPending}
        >
          {create.isPending ? 'Adding…' : 'Add objective'}
        </Button>
      </div>
    </Card>
  );
}

function TicketTitle({ ticket }: { ticket: TicketDetailDto }) {
  const update = useUpdateTicket(ticket.id);

  return (
    <section className="border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-5 py-3">
      <h1 className="text-base font-semibold leading-snug">
        <InlineEditField
          value={ticket.title}
          ariaLabel="Ticket title"
          onSave={title => update.mutate({ title })}
        />
      </h1>
    </section>
  );
}

export function TicketPanel({ projectId, ticketId }: { projectId: string; ticketId: string }) {
  const navigate = useNavigate();
  const ticketQ = useTicket(ticketId);

  const handleProjectChanged = (nextProjectId: string) => {
    navigate({
      to: '/projects/$projectId/tickets/$ticketId',
      params: { projectId: nextProjectId, ticketId }
    });
  };

  const closeToProject = (targetProjectId: string) => {
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
    <div className="flex h-full min-h-0 min-w-[320px] flex-col bg-[var(--color-surface-1)]">
      <TicketPanelHeader
        ticket={ticket}
        projectId={ticket.projectId}
        onClose={() => closeToProject(ticket.projectId)}
        onProjectChanged={handleProjectChanged}
      />
      <TicketTitle ticket={ticket} />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-[var(--color-surface-0)] pb-10">
        {/* Card section — primary work surface: objectives */}
        <section className="border-b border-[var(--color-border)] bg-[var(--color-surface-1)] py-5">
          <div className="mb-3 px-5"></div>
          <div className="flex flex-col gap-3 px-5 pb-1">
            <TicketObjectivesSection ticket={ticket} />
            <AddObjective ticketId={ticket.id} projectId={ticket.projectId} />
          </div>
        </section>

        {/* Subtle section — supporting context: tools and activity */}
        <section className="flex flex-col gap-6 px-5 pt-5">
          <TicketToolsAndCriteria
            ticketId={ticket.id}
            availableTools={ticket.availableTools}
            acceptanceCriteria={ticket.acceptanceCriteria}
          />

          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
              Activity
            </h2>
            <LiveActivityFeed ticketId={ticket.id} />
          </div>

          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
              Artifacts
            </h2>
            <TicketArtifactsSection ticketId={ticket.id} />
          </div>

          <div className="space-y-3 pb-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
              File Changes
            </h2>
            <LiveFileChanges ticketId={ticket.id} />
          </div>
        </section>
      </div>
    </div>
  );
}
