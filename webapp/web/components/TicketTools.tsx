import { useState } from 'react';

import { useUpdateTicket } from '../lib/queries.ts';
import { Button, Card, Field, TextArea } from './ui.tsx';

interface TicketToolsProps {
  ticketId: string;
  availableTools: string[];
}

export function TicketTools({ ticketId, availableTools }: TicketToolsProps) {
  const update = useUpdateTicket(ticketId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const toolsText = availableTools.join('\n');

  if (!editing) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tools</p>
        <div
          className="cursor-text rounded px-0.5 py-0.5 text-sm hover:bg-muted"
          onClick={() => {
            setDraft(toolsText);
            setEditing(true);
          }}
          title="Click to edit"
        >
          {availableTools.length > 0 ? (
            <ul className="space-y-0.5">
              {availableTools.map((tool, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span>{tool}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="italic text-muted-foreground">None specified — click to add.</span>
          )}
        </div>
      </div>
    );
  }

  const commit = () => {
    const tools = draft
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    update.mutate({ availableTools: tools });
    setEditing(false);
  };

  return (
    <Card className="space-y-3 p-3">
      <Field label="Tools">
        <TextArea
          autoFocus
          rows={4}
          value={draft}
          placeholder="One tool per line (e.g. bash, git, npm)"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              setDraft(toolsText);
              setEditing(false);
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
          }}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setDraft(toolsText);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
        <Button variant="primary" onClick={commit} disabled={update.isPending}>
          Save
        </Button>
      </div>
    </Card>
  );
}
