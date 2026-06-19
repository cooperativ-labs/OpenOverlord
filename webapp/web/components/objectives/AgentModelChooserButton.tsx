import { Bot, ChevronDown } from 'lucide-react';
import { useState } from 'react';

import type { AgentCatalogDto, AgentLaunchConfigDto } from '../../../shared/contract.ts';
import { getAgentIcon } from '../../lib/helpers/agent-icons.ts';
import { cn } from '../../lib/utils.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';

import { AgentIcon } from './AgentIcon.tsx';
import { type AgentModelSelection, AgentModelSelector } from './AgentModelSelector.tsx';

type AgentModelChooserButtonProps = {
  catalog: AgentCatalogDto | null;
  selection: AgentModelSelection;
  onChange: (selection: AgentModelSelection) => void;
  agentConfigs: Record<string, AgentLaunchConfigDto>;
  onLaunchConfigCommit: (agentKey: string, config: AgentLaunchConfigDto) => void;
  disabled?: boolean;
  /** Icon-only trigger for dense surfaces such as the quick task bar. */
  compact?: boolean;
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
  disabled = false,
  compact = false
}: AgentModelChooserButtonProps) {
  const [open, setOpen] = useState(false);
  const agent = catalog?.agents.find(a => a.key === selection.agent);
  const model = agent?.models.find(m => m.id === selection.model);
  const agentLabel = agent ? agent.label : selection.agent;
  const fullLabel = model ? `${agentLabel} · ${model.displayName}` : agentLabel;
  const label = model ? model.displayName : agentLabel;
  const triggerLabel = `Choose agent and model: ${fullLabel}`;
  const agentIconKey = agent?.key ?? selection.agent;
  const hasAgentIcon = getAgentIcon(agentIconKey) !== null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={open ? false : undefined}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              disabled={disabled || !catalog}
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs text-muted-foreground shadow-sm transition-colors',
                compact ? 'shrink-0' : 'max-w-[230px]',
                disabled || !catalog
                  ? 'cursor-not-allowed opacity-60'
                  : 'cursor-pointer hover:bg-accent hover:text-accent-foreground'
              )}
              aria-label={compact ? triggerLabel : undefined}
              title={compact ? triggerLabel : 'Choose agent and model'}
            >
              {hasAgentIcon ? (
                <AgentIcon
                  agentKey={agentIconKey}
                  size={14}
                  alt=""
                  className="h-3.5 w-3.5 shrink-0"
                />
              ) : (
                <Bot className="h-3.5 w-3.5 shrink-0" />
              )}
              {compact ? null : <span className="max-w-[160px] truncate">{label}</span>}
              <ChevronDown className="h-3 w-3 shrink-0" />
            </PopoverTrigger>
          }
        />
        <TooltipContent side="top" hidden={!compact}>
          {fullLabel}
        </TooltipContent>
      </Tooltip>
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
