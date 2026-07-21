import { Plus, X } from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react';

import {
  agentLaunchFlagKey,
  formatAgentLaunchFlagText,
  type AgentLaunchConfigDto,
  type AgentLaunchFlagDto
} from '../../../shared/contract.ts';
import {
  filterRecentAgentLaunchFlags,
  readRecentAgentLaunchFlags,
  recordRecentAgentLaunchFlag
} from '../../lib/recent-agent-launch-flags.ts';
import { cn } from '../../lib/utils.ts';

type AgentLaunchFooterProps = {
  /** Agent key the pre-command / flags are stored under. */
  agentKey: string;
  /** Initial pre-command for this agent. Empty string means none. */
  preCommand: string;
  /** Initial flags for this agent. */
  flags: AgentLaunchFlagDto[];
  /**
   * Called with the full launch config whenever an edit is committed (blur /
   * Enter / chip add-remove). The parent decides where it persists — per-user
   * target config by default, or an objective override on launch surfaces.
   */
  onCommit: (config: AgentLaunchConfigDto) => void;
  /** Short hint describing where the shown config comes from. */
  sourceHint?: string;
};

function cleanFlags(raw: AgentLaunchFlagDto[]): AgentLaunchFlagDto[] {
  return raw
    .map(flag => ({
      name: flag.name.trim(),
      value: flag.value?.trim() ? flag.value.trim() : null
    }))
    .filter(flag => flag.name.length > 0);
}

/**
 * Footer for the AgentModelSelector showing the selected agent's launch
 * pre-command (left, 1/3) and command flags (right, 2/3). Each flag is a
 * name/value pair so positional agent options (e.g. `--permission-mode auto`)
 * are first-class. Commits flow through `onCommit` so the hosting surface
 * controls persistence. Mount with a `key` of the agent so fields re-seed when
 * the agent changes.
 */
export function AgentLaunchFooter({
  agentKey,
  preCommand: initialPreCommand,
  flags: initialFlags,
  onCommit,
  sourceHint
}: AgentLaunchFooterProps) {
  const [preCommand, setPreCommand] = useState(initialPreCommand);
  const [flags, setFlags] = useState<AgentLaunchFlagDto[]>(initialFlags);
  const [draftName, setDraftName] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [recentFlags, setRecentFlags] = useState<AgentLaunchFlagDto[]>([]);
  const [isSuggestionOpen, setIsSuggestionOpen] = useState(false);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const suggestionListId = useId();
  const draftContainerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setRecentFlags(readRecentAgentLaunchFlags(agentKey));
  }, [agentKey]);

  const suggestions = useMemo(
    () => filterRecentAgentLaunchFlags({ flags: recentFlags, query: draftName }),
    [draftName, recentFlags]
  );

  useEffect(() => {
    setActiveSuggestionIndex(0);
  }, [draftName, suggestions.length]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        draftContainerRef.current &&
        !draftContainerRef.current.contains(event.target as Node)
      ) {
        setIsSuggestionOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const commitPreCommand = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      setPreCommand(trimmed);
      onCommit({ preCommand: trimmed, flags: cleanFlags(flags) });
    },
    [flags, onCommit]
  );

  const commitFlags = useCallback(
    (raw: AgentLaunchFlagDto[]) => {
      const cleaned = cleanFlags(raw);
      setFlags(cleaned);
      onCommit({ preCommand: preCommand.trim(), flags: cleaned });
    },
    [onCommit, preCommand]
  );

  const applySuggestion = useCallback((flag: AgentLaunchFlagDto) => {
    setDraftName(flag.name);
    setDraftValue(flag.value ?? '');
    setIsSuggestionOpen(false);
  }, []);

  const addFlag = useCallback(() => {
    const name = draftName.trim();
    if (!name) return;
    const value = draftValue.trim();
    const nextFlag: AgentLaunchFlagDto = { name, value: value.length > 0 ? value : null };
    commitFlags([...flags, nextFlag]);
    recordRecentAgentLaunchFlag({ agentKey, flag: nextFlag });
    setRecentFlags(readRecentAgentLaunchFlags(agentKey));
    setDraftName('');
    setDraftValue('');
    setIsSuggestionOpen(false);
  }, [agentKey, commitFlags, draftName, draftValue, flags]);

  const handleDraftNameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (!isSuggestionOpen || suggestions.length === 0) {
        if (event.key === 'Enter') {
          event.preventDefault();
          addFlag();
        }
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setIsSuggestionOpen(true);
        setActiveSuggestionIndex(prev => Math.min(prev + 1, suggestions.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveSuggestionIndex(prev => Math.max(prev - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        applySuggestion(suggestions[activeSuggestionIndex]);
      } else if (event.key === 'Escape') {
        setIsSuggestionOpen(false);
      }
    },
    [activeSuggestionIndex, addFlag, applySuggestion, isSuggestionOpen, suggestions]
  );

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
          <div className="flex flex-col gap-1.5">
            {flags.map((flag, index) => (
              <span
                key={agentLaunchFlagKey(flag)}
                className="flex items-center gap-1 rounded border bg-muted/40 px-1.5 py-0.5"
              >
                <input
                  type="text"
                  value={flag.name}
                  aria-label={`Flag ${index + 1} name`}
                  placeholder="--flag"
                  style={{ width: `${Math.max(flag.name.length, 6) + 1}ch` }}
                  onChange={event =>
                    setFlags(current =>
                      current.map((existing, i) =>
                        i === index ? { ...existing, name: event.target.value } : existing
                      )
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
                <input
                  type="text"
                  value={flag.value ?? ''}
                  aria-label={`Flag ${index + 1} value`}
                  placeholder="value (optional)"
                  style={{ width: `${Math.max((flag.value ?? '').length, 8) + 1}ch` }}
                  onChange={event =>
                    setFlags(current =>
                      current.map((existing, i) =>
                        i === index ? { ...existing, value: event.target.value } : existing
                      )
                    )
                  }
                  onBlur={() => commitFlags(flags)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  className="min-w-[8ch] flex-1 bg-transparent py-1 font-mono text-xs focus:outline-none"
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
            <span
              ref={draftContainerRef}
              className="relative flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5"
            >
              <input
                type="text"
                placeholder="--flag"
                value={draftName}
                aria-label="Add flag name"
                role="combobox"
                aria-expanded={isSuggestionOpen && suggestions.length > 0}
                aria-controls={suggestionListId}
                aria-autocomplete="list"
                style={{ width: `${Math.max(draftName.length, 6) + 1}ch` }}
                onChange={event => {
                  setDraftName(event.target.value);
                  setIsSuggestionOpen(true);
                }}
                onFocus={() => setIsSuggestionOpen(true)}
                onKeyDown={handleDraftNameKeyDown}
                className="bg-transparent py-1 font-mono text-xs focus:outline-none"
              />
              {isSuggestionOpen && suggestions.length > 0 ? (
                <ul
                  id={suggestionListId}
                  role="listbox"
                  className="absolute left-0 top-full z-20 mt-1 w-full min-w-[16rem] overflow-hidden rounded-md border border-border bg-popover shadow-md"
                >
                  {suggestions.map((flag, index) => {
                    const isActive = index === activeSuggestionIndex;
                    return (
                      <li
                        key={agentLaunchFlagKey(flag)}
                        role="option"
                        aria-selected={isActive}
                        className={cn(
                          'cursor-pointer px-2 py-1.5 font-mono text-xs',
                          isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/80'
                        )}
                        onMouseDown={event => {
                          event.preventDefault();
                          applySuggestion(flag);
                        }}
                        onMouseEnter={() => setActiveSuggestionIndex(index)}
                      >
                        {formatAgentLaunchFlagText(flag)}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              <input
                type="text"
                placeholder="value (optional)"
                value={draftValue}
                aria-label="Add flag value"
                style={{ width: `${Math.max(draftValue.length, 8) + 1}ch` }}
                onChange={event => setDraftValue(event.target.value)}
                onBlur={addFlag}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addFlag();
                  }
                }}
                className="min-w-[8ch] flex-1 bg-transparent py-1 font-mono text-xs focus:outline-none"
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
