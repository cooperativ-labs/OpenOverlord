import { Check } from 'lucide-react';
import { useCallback } from 'react';

import type { AgentCatalogDto, AgentLaunchConfigDto } from '../../../shared/contract.ts';
import { cn } from '../../lib/utils.ts';

import { AgentLaunchFooter } from './AgentLaunchFooter.tsx';

/** The user's current agent/model/reasoning choice. */
export interface AgentModelSelection {
  agent: string;
  model: string | null;
  reasoningEffort: string | null;
}

type AgentModelSelectorProps = {
  /** Workspace agent catalog (built-ins + workspace availability). */
  catalog: AgentCatalogDto;
  value: AgentModelSelection;
  /**
   * Called for every selection change. The hosting surface persists it —
   * typically to the objective's assigned agent/model and the project's
   * launch preference (see useObjectiveAgentSelection).
   */
  onChange: (selection: AgentModelSelection) => void;
  /**
   * Per-user launch mechanics keyed by agent (from `/api/launch-settings`,
   * i.e. the user's user_execution_target_preferences row). The footer seeds
   * from the selected agent's entry.
   */
  agentConfigs: Record<string, AgentLaunchConfigDto>;
  /** Persist a pre-command/flags edit for the given agent. */
  onLaunchConfigCommit: (agentKey: string, config: AgentLaunchConfigDto) => void;
  /** Hint shown under the footer describing where edits persist. */
  launchConfigSourceHint?: string;
  /** When true, stacks columns vertically (settings page); compact rows otherwise. */
  inline?: boolean;
};

function optionButtonClasses(isSelected: boolean): string {
  return cn(
    'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
    isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
  );
}

/**
 * Reusable agent / model / reasoning selector with the launch footer.
 * Stateless about persistence: catalog data, the user's launch configs, and
 * the persistence callbacks are piped in so the same component serves the
 * objective popover today and settings surfaces later.
 */
export function AgentModelSelector({
  catalog,
  value,
  onChange,
  agentConfigs,
  onLaunchConfigCommit,
  launchConfigSourceHint,
  inline = false
}: AgentModelSelectorProps) {
  // Offered agents: available by default, plus the currently selected agent
  // even if the workspace hid it (so an existing assignment stays visible).
  const visibleAgents = catalog.agents.filter(
    agent => agent.availableByDefault || agent.key === value.agent
  );
  const selectedAgent = catalog.agents.find(agent => agent.key === value.agent) ?? null;
  const models = selectedAgent?.models ?? [];
  const selectedModel = models.find(m => m.id === value.model) ?? null;
  const reasoningOptions = selectedModel?.reasoningOptions ?? [];
  const launchConfig = agentConfigs[value.agent];

  const handleAgentChange = useCallback(
    (agentKey: string) => {
      if (agentKey === value.agent) return;
      // Model/reasoning are agent-specific; reset on agent change.
      onChange({ agent: agentKey, model: null, reasoningEffort: null });
    },
    [onChange, value.agent]
  );

  const handleModelChange = useCallback(
    (modelId: string | null) => {
      onChange({ agent: value.agent, model: modelId, reasoningEffort: null });
    },
    [onChange, value.agent]
  );

  const handleReasoningChange = useCallback(
    (reasoningEffort: string | null) => {
      onChange({ agent: value.agent, model: value.model, reasoningEffort });
    },
    [onChange, value.agent, value.model]
  );

  return (
    <div className="flex flex-col gap-3">
      <div className={cn('flex gap-3', inline ? 'flex-col' : 'flex-row')}>
        {/* Agent column */}
        <div className={cn('flex flex-col gap-0.5', inline ? 'w-full' : 'min-w-[110px]')}>
          <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Agent
          </p>
          {visibleAgents.map(agent => {
            const isSelected = value.agent === agent.key;
            return (
              <button
                key={agent.key}
                type="button"
                onClick={() => handleAgentChange(agent.key)}
                className={optionButtonClasses(isSelected)}
              >
                <span className="truncate">{agent.label}</span>
                {isSelected && <Check className="ml-auto h-3 w-3 shrink-0" />}
              </button>
            );
          })}
          {visibleAgents.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No agents available</p>
          ) : null}
        </div>

        {/* Model column */}
        <div className={cn('flex flex-col gap-0.5', inline ? 'w-full' : 'min-w-[160px]')}>
          <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Model
          </p>
          <button
            type="button"
            onClick={() => handleModelChange(null)}
            className={optionButtonClasses(value.model === null)}
            title="Let the agent use its own default model"
          >
            <span className="truncate text-muted-foreground">Default</span>
            {value.model === null && <Check className="ml-auto h-3 w-3 shrink-0" />}
          </button>
          {models.length > 0 ? (
            <div className="max-h-[220px] overflow-y-auto">
              {models.map(model => {
                const isSelected = value.model === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => handleModelChange(model.id)}
                    className={optionButtonClasses(isSelected)}
                  >
                    <span className="truncate">{model.displayName}</span>
                    {isSelected && <Check className="ml-auto h-3 w-3 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No models in the catalog</p>
          )}
        </div>

        {/* Reasoning column — only when the selected model offers options */}
        {reasoningOptions.length > 0 && (
          <div className={cn('flex flex-col gap-0.5', inline ? 'w-full' : 'min-w-[90px]')}>
            <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {selectedAgent?.reasoningLabel ?? 'Thinking'}
            </p>
            <button
              type="button"
              onClick={() => handleReasoningChange(null)}
              className={optionButtonClasses(value.reasoningEffort === null)}
            >
              <span className="truncate text-muted-foreground">Default</span>
              {value.reasoningEffort === null && <Check className="ml-auto h-3 w-3 shrink-0" />}
            </button>
            {reasoningOptions.map(option => {
              const isSelected = value.reasoningEffort === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => handleReasoningChange(option)}
                  className={cn(optionButtonClasses(isSelected), 'capitalize')}
                >
                  <span className="truncate">{option}</span>
                  {isSelected && <Check className="ml-auto h-3 w-3 shrink-0" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Keyed by agent so the fields re-seed from the new agent's config. */}
      <AgentLaunchFooter
        key={value.agent}
        agentKey={value.agent}
        preCommand={launchConfig?.preCommand ?? ''}
        flags={launchConfig?.flags ?? []}
        onCommit={config => onLaunchConfigCommit(value.agent, config)}
        sourceHint={launchConfigSourceHint}
      />
    </div>
  );
}
