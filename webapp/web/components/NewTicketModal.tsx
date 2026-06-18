import { useEffect, useMemo, useState } from 'react';

import { RepositoryMentionTextarea } from '@/components/RepositoryMentionTextarea.tsx';
import { Button, Field, Modal, Select } from '@/components/ui.tsx';
import { useCreateTicket, useProjects, useProjectStatuses } from '@/lib/queries.ts';

import type { TicketPriority } from '../../shared/contract.ts';

const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

type NewTicketModalProps = {
  open: boolean;
  onClose: () => void;
  defaultProjectId?: string | null;
};

export function NewTicketModal({ open, onClose, defaultProjectId = null }: NewTicketModalProps) {
  const create = useCreateTicket();
  const projectsQ = useProjects();
  const projects = useMemo(() => projectsQ.data ?? [], [projectsQ.data]);

  const [instruction, setInstruction] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [projectId, setProjectId] = useState('');
  const [statusId, setStatusId] = useState('');

  const selectedProjectId =
    projectId ||
    (defaultProjectId && projects.some(project => project.id === defaultProjectId)
      ? defaultProjectId
      : (projects[0]?.id ?? ''));
  const statusesQ = useProjectStatuses(selectedProjectId);
  const statuses = useMemo(() => statusesQ.data ?? [], [statusesQ.data]);

  useEffect(() => {
    if (!open) return;
    setInstruction('');
    setPriority('normal');
    setStatusId('');
    setProjectId(current => {
      if (defaultProjectId && projects.some(project => project.id === defaultProjectId)) {
        return defaultProjectId;
      }
      if (current && projects.some(project => project.id === current)) {
        return current;
      }
      return projects[0]?.id ?? '';
    });
  }, [defaultProjectId, open, projects]);

  useEffect(() => {
    if (!statusId) return;
    if (!statuses.some(status => status.id === statusId)) {
      setStatusId('');
    }
  }, [statusId, statuses]);

  const submit = () => {
    const text = instruction.trim();
    if (!text || !selectedProjectId) return;
    create.mutate(
      {
        projectId: selectedProjectId,
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
            projectId={selectedProjectId}
            value={instruction}
            placeholder="Describe the work to be executed… (@ file, # project, $ ticket)"
            onValueChange={setInstruction}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            }}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Project">
            <Select
              className="w-full"
              value={selectedProjectId}
              onChange={e => {
                setProjectId(e.target.value);
                setStatusId('');
              }}
              disabled={projects.length === 0}
            >
              {projects.length === 0 ? <option value="">No projects</option> : null}
              {projects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
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
            <Select
              className="w-full"
              value={statusId}
              onChange={e => setStatusId(e.target.value)}
              disabled={!selectedProjectId || statusesQ.isLoading}
            >
              <option value="">
                Default ({statuses.find(status => status.isDefault)?.name ?? '—'})
              </option>
              {statuses.map(status => (
                <option key={status.id} value={status.id}>
                  {status.name}
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
            disabled={!instruction.trim() || !selectedProjectId || create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create ticket'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
