import { Bot, ChevronDown } from 'lucide-react';

import type { AgentCatalogDto, AgentLaunchConfigDto } from '../../../shared/contract.ts';
import { cn } from '../../lib/utils.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

import { type AgentModelSelection, AgentModelSelector } from './AgentModelSelector.tsx';

type AgentModelChooserButtonProps = {
  catalog: AgentCatalogDto | null;
  selection: AgentModelSelection;
  onChange: (selection: AgentModelSelection) => void;
  agentConfigs: Record<string, AgentLaunchConfigDto>;
  onLaunchConfigCommit: (agentKey: string, config: AgentLaunchConfigDto) => void;
  disabled?: boolean;
};

/**
 * Compact popover trigger showing the current agent/model selection; opens the
 * shared AgentModelSelector. All data and persistence callbacks are piped in
 * by the host (see useObjectiveAgentSelection).
 */
export function AgentModelChooserButton({
  catalog,
  selection,
  onChange,
  agentConfigs,
  onLaunchConfigCommit,
  disabled = false
}: AgentModelChooserButtonProps) {
  const agent = catalog?.agents.find(a => a.key === selection.agent);
  const model = agent?.models.find(m => m.id === selection.model);
  const label = agent
    ? model
      ? `${agent.label} · ${model.displayName}`
      : agent.label
    : selection.agent;

  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled || !catalog}
        className={cn(
          'inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground shadow-sm transition-colors',
          disabled || !catalog
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
        )}
        title="Choose agent and model"
      >
        <Bot className="h-3.5 w-3.5" />
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown className="h-3 w-3" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto min-w-[360px]">
        {catalog ? (
          <AgentModelSelector
            catalog={catalog}
            value={selection}
            onChange={onChange}
            agentConfigs={agentConfigs}
            onLaunchConfigCommit={onLaunchConfigCommit}
            launchConfigSourceHint="Saved to your launch config for this machine."
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
