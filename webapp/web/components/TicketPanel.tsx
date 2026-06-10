import { useNavigate } from '@tanstack/react-router';
import { ArrowRightToLine } from 'lucide-react';
import { useState } from 'react';

import type {
  ObjectiveDto,
  ObjectiveState,
  ProjectStatusDto,
  TicketDetailDto,
  TicketPriority
} from '../../shared/contract.ts';
import {
  useCreateObjective,
  useDeleteObjective,
  useDeleteTicket,
  useTicket,
  useUpdateObjective,
  useUpdateTicket
} from '../lib/queries.ts';

import {
  Badge,
  Button,
  Card,
  EditableText,
  Field,
  OBJECTIVE_STATE_LABEL,
  priorityClasses,
  Select,
  Spinner,
  statusClasses,
  TextArea
} from './ui.tsx';

const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];
const OBJECTIVE_STATES: ObjectiveState[] = [
  'future',
  'draft',
  'submitted',
  'launching',
  'executing',
  'pending_delivery',
  'complete'
];

function ObjectiveItem({ objective }: { objective: ObjectiveDto }) {
  const update = useUpdateObjective();
  const remove = useDeleteObjective();

  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-xs text-[var(--color-ink-dim)]">
            #{objective.position + 1}
          </span>
          <span className="truncate text-sm font-medium">
            <EditableText
              value={objective.title ?? ''}
              placeholder="Untitled objective"
              onSave={title => update.mutate({ id: objective.id, body: { title } })}
            />
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select
            className="text-xs"
            value={objective.state}
            onChange={e =>
              update.mutate({
                id: objective.id,
                body: { state: e.target.value as ObjectiveState }
              })
            }
          >
            {OBJECTIVE_STATES.map(s => (
              <option key={s} value={s}>
                {OBJECTIVE_STATE_LABEL[s]}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            aria-label="Delete objective"
            onClick={() => {
              if (confirm('Delete this objective?')) remove.mutate(objective.id);
            }}
          >
            ✕
          </Button>
        </div>
      </div>
      <div className="mt-2 text-sm text-[var(--color-ink-dim)]">
        <EditableText
          multiline
          value={objective.instructionText}
          className="block whitespace-pre-wrap"
          inputClassName="text-sm"
          onSave={instructionText => update.mutate({ id: objective.id, body: { instructionText } })}
        />
      </div>
    </Card>
  );
}

function AddObjective({ ticketId }: { ticketId: string }) {
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
        <TextArea
          autoFocus
          rows={3}
          value={instruction}
          placeholder="Describe what the agent should do…"
          onChange={e => setInstruction(e.target.value)}
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
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface-0)]">
      <TicketPanelHeader
        ticket={ticket}
        statuses={ticket.statuses}
        projectId={projectId}
        onClose={closePanel}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-dim)]">
            Objectives ({ticket.objectives.length})
          </h2>
          {ticket.objectives.map(o => (
            <ObjectiveItem key={o.id} objective={o} />
          ))}
          <AddObjective ticketId={ticket.id} />
        </div>
      </div>
    </div>
  );
}
