import { useState } from 'react';

import { RepositoryMentionTextarea } from '@/components/RepositoryMentionTextarea.tsx';
import { Button, Field, Modal, Select } from '@/components/ui.tsx';

import type { ProjectStatusDto, TicketPriority } from '../../shared/contract.ts';
import { useCreateTicket } from '../lib/queries.ts';

import { PRIORITIES } from './board-shared.ts';

export function NewTicketModal({
  open,
  onClose,
  projectId,
  statuses
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  statuses: ProjectStatusDto[];
}) {
  const create = useCreateTicket();
  const [instruction, setInstruction] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [statusId, setStatusId] = useState('');

  const submit = () => {
    const text = instruction.trim();
    if (!text) return;
    create.mutate(
      {
        projectId,
        firstObjective: text,
        priority,
        statusId: statusId || undefined
      },
      {
        onSuccess: () => {
          setInstruction('');
          setPriority('normal');
          setStatusId('');
          onClose();
        }
      }
    );
  };

  return (
    <Modal title="New ticket" open={open} onClose={onClose}>
      <div className="space-y-4">
        <Field label="What needs to be done?">
          <RepositoryMentionTextarea
            autoFocus
            rows={3}
            projectId={projectId}
            value={instruction}
            placeholder="Describe the work to be executed… (@ file, # project, $ ticket)"
            onValueChange={setInstruction}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select
              className="w-full"
              value={priority}
              onChange={e => setPriority(e.target.value as TicketPriority)}
            >
              {PRIORITIES.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select className="w-full" value={statusId} onChange={e => setStatusId(e.target.value)}>
              <option value="">Default ({statuses.find(s => s.isDefault)?.name ?? '—'})</option>
              {statuses.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {create.isError && (
          <p className="text-xs text-red-400">{(create.error as Error).message}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!instruction.trim() || create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create ticket'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
