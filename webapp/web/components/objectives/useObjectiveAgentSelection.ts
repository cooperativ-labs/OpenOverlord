import { useCallback, useMemo } from 'react';

import type { AgentLaunchConfigDto, ObjectiveDto } from '../../../shared/contract.ts';
import {
  useAgentCatalog,
  useLaunchPreference,
  useLaunchSettings,
  useUpdateAgentLaunchConfig,
  useUpdateLaunchPreference,
  useUpdateObjective
} from '../../lib/queries.ts';

import type { AgentModelSelection } from './AgentModelSelector.tsx';

/**
 * Wires an objective's agent/model selection to its storage owners, following
 * connectors/docs/agent-harness-configuration-architecture.md:
 *
 * - The effective selection resolves objective assignment → project user
 *   preference → instance default (overlord.toml via the catalog endpoint).
 * - Selection changes persist to BOTH the objective (`assigned_agent`,
 *   `model`, `reasoning_effort`) and the project launch preference, so the
 *   next objective in this project starts from the same choice.
 * - Launch-config (pre-command/flags) edits persist to the user's per-target
 *   agent configs (`user_execution_target_preferences.agent_configs_json`) —
 *   launch mechanics, not preference.
 */
export function useObjectiveAgentSelection(objective: ObjectiveDto) {
  const catalogQ = useAgentCatalog();
  const settingsQ = useLaunchSettings();
  const preferenceQ = useLaunchPreference(objective.projectId);
  const updateObjective = useUpdateObjective();
  const updatePreference = useUpdateLaunchPreference(objective.projectId);
  const updateAgentConfig = useUpdateAgentLaunchConfig();

  const catalog = catalogQ.data ?? null;
  const preference = preferenceQ.data ?? null;
  const agentConfigs = settingsQ.data?.agentConfigs ?? {};
  const loaded = Boolean(catalog) && !preferenceQ.isLoading;

  const selection = useMemo<AgentModelSelection>(() => {
    if (objective.assignedAgent) {
      return {
        agent: objective.assignedAgent,
        model: objective.model,
        reasoningEffort: objective.reasoningEffort
      };
    }
    if (preference?.selectedAgent) {
      return {
        agent: preference.selectedAgent,
        model: preference.selectedModel,
        reasoningEffort: preference.selectedReasoningEffort
      };
    }
    return {
      agent: catalog?.defaultAgent ?? 'claude',
      model: catalog?.defaultModel ?? null,
      reasoningEffort: null
    };
  }, [catalog, objective.assignedAgent, objective.model, objective.reasoningEffort, preference]);

  const setSelection = useCallback(
    (next: AgentModelSelection) => {
      // Both persistence calls must succeed for the selector to treat the
      // change as committed; either failing should surface to the caller so
      // it can stop a per-button loading indicator.
      return Promise.all([
        updateObjective.mutateAsync({
          id: objective.id,
          body: {
            assignedAgent: next.agent,
            model: next.model,
            reasoningEffort: next.reasoningEffort
          }
        }),
        updatePreference.mutateAsync({
          selectedAgent: next.agent,
          selectedModel: next.model,
          selectedReasoningEffort: next.reasoningEffort
        })
      ]).then(() => undefined);
    },
    [objective.id, updateObjective, updatePreference]
  );

  const commitLaunchConfig = useCallback(
    (agentKey: string, config: AgentLaunchConfigDto) => {
      updateAgentConfig.mutate({ agentKey, body: config });
    },
    [updateAgentConfig]
  );

  return { catalog, agentConfigs, preference, selection, setSelection, commitLaunchConfig, loaded };
}
