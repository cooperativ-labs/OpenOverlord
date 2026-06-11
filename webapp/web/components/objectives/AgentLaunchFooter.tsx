import { Plus, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { AgentLaunchConfigDto } from '../../../shared/contract.ts';

type AgentLaunchFooterProps = {
  /** Agent key the pre-command / flags are stored under. */
  agentKey: string;
  /** Initial pre-command for this agent. Empty string means none. */
  preCommand: string;
  /** Initial flags for this agent. */
  flags: string[];
  /**
   * Called with the full launch config whenever an edit is committed (blur /
   * Enter / chip add-remove). The parent decides where it persists — per-user
   * target config by default, or an objective override on launch surfaces.
   */
  onCommit: (config: AgentLaunchConfigDto) => void;
  /** Short hint describing where the shown config comes from. */
  sourceHint?: string;
};

/**
 * Footer for the AgentModelSelector showing the selected agent's launch
 * pre-command (left, 1/3) and command flags (right, 2/3). Both are editable;
 * commits flow through `onCommit` so the hosting surface controls persistence.
 * Mount with a `key` of the agent so fields re-seed when the agent changes.
 */
export function AgentLaunchFooter({
  agentKey,
  preCommand: initialPreCommand,
  flags: initialFlags,
  onCommit,
  sourceHint
}: AgentLaunchFooterProps) {
  const [preCommand, setPreCommand] = useState(initialPreCommand);
  const [flags, setFlags] = useState<string[]>(initialFlags);
  const [flagDraft, setFlagDraft] = useState('');

  const commitPreCommand = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      setPreCommand(trimmed);
      onCommit({ preCommand: trimmed, flags });
    },
    [flags, onCommit]
  );

  const commitFlags = useCallback(
    (raw: string[]) => {
      const cleaned = raw.map(flag => flag.trim()).filter(flag => flag.length > 0);
      setFlags(cleaned);
      onCommit({ preCommand: preCommand.trim(), flags: cleaned });
    },
    [onCommit, preCommand]
  );

  const addFlag = useCallback(() => {
    const value = flagDraft.trim();
    if (!value) return;
    commitFlags([...flags, value]);
    setFlagDraft('');
  }, [commitFlags, flagDraft, flags]);

  return (
    <div className="mt-1 flex flex-col gap-1 border-t pt-3" data-agent-key={agentKey}>
      <div className="flex flex-row gap-3">
        {/* Pre-command — 1/3 */}
        <div className="flex w-1/3 min-w-0 flex-col gap-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Pre-command
          </p>
          <input
            type="text"
            placeholder="none"
            value={preCommand}
            onChange={event => setPreCommand(event.target.value)}
            onBlur={event => commitPreCommand(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitPreCommand(event.currentTarget.value);
                event.currentTarget.blur();
              }
            }}
            className="w-full rounded border bg-background px-2 py-1 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Flags — 2/3 */}
        <div className="flex w-2/3 min-w-0 flex-col gap-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Flags
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {flags.map((flag, index) => (
              <span
                key={index}
                className="flex items-center gap-1 rounded border bg-muted/40 pl-1.5 pr-0.5"
              >
                <input
                  type="text"
                  value={flag}
                  aria-label={`Flag ${index + 1}`}
                  style={{ width: `${Math.max(flag.length, 4) + 1}ch` }}
                  onChange={event =>
                    setFlags(current =>
                      current.map((existing, i) => (i === index ? event.target.value : existing))
                    )
                  }
                  onBlur={() => commitFlags(flags)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  className="bg-transparent py-1 font-mono text-xs focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => commitFlags(flags.filter((_, i) => i !== index))}
                  title="Remove flag"
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/20"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <span className="flex items-center gap-1 rounded border border-dashed pl-1.5 pr-0.5">
              <input
                type="text"
                placeholder="--flag"
                value={flagDraft}
                aria-label="Add flag"
                style={{ width: `${Math.max(flagDraft.length, 6) + 1}ch` }}
                onChange={event => setFlagDraft(event.target.value)}
                onBlur={addFlag}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addFlag();
                  }
                }}
                className="bg-transparent py-1 font-mono text-xs focus:outline-none"
              />
              <button
                type="button"
                onClick={addFlag}
                title="Add flag"
                className="rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/20"
              >
                <Plus className="h-3 w-3" />
              </button>
            </span>
          </div>
        </div>
      </div>
      {sourceHint ? <p className="text-[10px] text-muted-foreground">{sourceHint}</p> : null}
    </div>
  );
}
