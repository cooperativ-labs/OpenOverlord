import { useNavigate } from '@tanstack/react-router';
import { ArrowRightToLine } from 'lucide-react';
import { useState } from 'react';

import type { ProjectStatusDto, TicketDetailDto, TicketPriority } from '../../shared/contract.ts';
import { useCreateObjective, useDeleteTicket, useTicket, useUpdateTicket } from '../lib/queries.ts';

import { TicketObjectivesSection } from './objectives/TicketObjectivesSection.tsx';
import { LiveActivityFeed } from './LiveActivityFeed.tsx';
import { RepositoryMentionTextarea } from './RepositoryMentionTextarea.tsx';
import { TicketTools } from './TicketTools.tsx';
import {
  Badge,
  Button,
  Card,
  EditableText,
  Field,
  priorityClasses,
  Select,
  Spinner,
  statusClasses
} from './ui.tsx';

const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

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
          placeholder="Describe what the agent should do… (type @ to mention a file)"
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

function TicketPanelHeader({
  ticket,
  statuses,
  projectId,
  onClose
}: {
  ticket: TicketDetailDto;
  statuses: ProjectStatusDto[];
  projectId: string;
  onClose: () => void;
}) {
  const update = useUpdateTicket(ticket.id);
  const remove = useDeleteTicket();
  const navigate = useNavigate();
  const status = statuses.find(s => s.id === ticket.statusId);

  return (
    <header className="shrink-0 border-b border-[var(--color-border)] px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" aria-label="Close ticket panel" onClick={onClose}>
            <ArrowRightToLine className="h-4 w-4" />
          </Button>
          <span className="font-mono text-xs text-[var(--color-ink-dim)]">{ticket.displayId}</span>
          {status && <Badge className={statusClasses(status.type)}>{status.name}</Badge>}
        </div>
        <Button
          variant="danger"
          onClick={() => {
            if (confirm(`Delete ticket ${ticket.displayId}? This also removes its objectives.`)) {
              remove.mutate(ticket.id, {
                onSuccess: () => navigate({ to: '/projects/$projectId', params: { projectId } })
              });
            }
          }}
        >
          Delete
        </Button>
      </div>

      <h1 className="text-base font-semibold leading-snug">
        <EditableText value={ticket.title} onSave={title => update.mutate({ title })} />
      </h1>

      <div className="mt-3 grid grid-cols-1 gap-2">
        <Field label="Status">
          <Select
            className="w-full"
            value={ticket.statusId}
            onChange={e => update.mutate({ statusId: e.target.value })}
          >
            {statuses.map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority">
          <div className="flex items-center gap-2">
            <Select
              className="w-full"
              value={ticket.priority ?? 'normal'}
              onChange={e => update.mutate({ priority: e.target.value as TicketPriority })}
            >
              {PRIORITIES.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
            {ticket.priority && (
              <Badge className={priorityClasses(ticket.priority)}>{ticket.priority}</Badge>
            )}
          </div>
        </Field>
      </div>
    </header>
  );
}

export function TicketPanel({ projectId, ticketId }: { projectId: string; ticketId: string }) {
  const navigate = useNavigate();
  const ticketQ = useTicket(ticketId);

  const closePanel = () => {
    navigate({ to: '/projects/$projectId', params: { projectId } });
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
          <Button variant="ghost" aria-label="Close ticket panel" onClick={closePanel}>
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
        statuses={ticket.statuses}
        projectId={projectId}
        onClose={closePanel}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-[var(--color-surface-0)] pb-10">
        {/* Card section — primary work surface: objectives */}
        <section className="border-b border-[var(--color-border)] bg-[var(--color-surface-1)] py-5">
          <div className="mb-3 px-5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
              Objectives ({ticket.objectives.length})
            </h2>
          </div>
          <div className="flex flex-col gap-3 px-5 pb-1">
            <TicketObjectivesSection ticket={ticket} />
            <AddObjective ticketId={ticket.id} projectId={projectId} />
          </div>
        </section>

        {/* Subtle section — supporting context: tools and activity */}
        <section className="flex flex-col gap-6 px-5 pt-5">
          <TicketTools ticketId={ticket.id} availableTools={ticket.availableTools} />

          <div className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
              Activity
            </h2>
            <LiveActivityFeed ticketId={ticket.id} />
          </div>
        </section>
      </div>
    </div>
  );
}
