import { ArrowUpCircle, Loader2 } from 'lucide-react';

import type {
  ExecutionRequestDto,
  ObjectiveDto,
  ObjectiveState
} from '../../../shared/contract.ts';
import { useProjectResources, useUpdateObjective } from '../../lib/queries.ts';
import { Button } from '../ui.tsx';

import { AgentLaunchButton } from './AgentLaunchButton.tsx';
import { AgentModelChooserButton } from './AgentModelChooserButton.tsx';
import { DraftObjectiveActions } from './DraftObjectiveActions.tsx';
import { ObjectiveResourcePicker } from './ObjectiveResourcePicker.tsx';
import { useObjectiveAgentSelection } from './useObjectiveAgentSelection.ts';

const ACTIVE_SIBLING_STATES: ObjectiveState[] = ['launching', 'executing', 'pending_delivery'];
const ACTIVE_EXECUTION_REQUEST_STATES: ExecutionRequestDto['status'][] = [
  'queued',
  'claimed',
  'launching'
];

type DraftObjectiveToolbarProps = {
  objective: ObjectiveDto;
  /** All objectives on the mission — used to detect an already-active sibling. */
  siblings: ObjectiveDto[];
  /** Active execution requests for the mission (from MissionDetailDto). */
  executionRequests: ExecutionRequestDto[];
};

export function DraftObjectiveToolbar({
  objective,
  siblings,
  executionRequests
}: DraftObjectiveToolbarProps) {
  const update = useUpdateObjective();
  const resourcesQ = useProjectResources(objective.projectId);
  const { catalog, agentConfigs, selection, setSelection, commitLaunchConfig, loaded } =
    useObjectiveAgentSelection(objective);

  const isFuture = objective.state === 'future';
  const isLaunching = objective.state === 'launching';
  const isSubmitted = objective.state === 'submitted';
  const isLaunchable = objective.state === 'draft' || isSubmitted || isLaunching;
  const activeSiblingObjective =
    siblings.find(o => o.id !== objective.id && ACTIVE_SIBLING_STATES.includes(o.state)) ?? null;
  const activeSiblingRequest =
    executionRequests.find(request => {
      if (request.objectiveId === objective.id) return false;
      if (!ACTIVE_EXECUTION_REQUEST_STATES.includes(request.status)) return false;
      const requestObjective = siblings.find(o => o.id === request.objectiveId);
      return Boolean(requestObjective && ACTIVE_SIBLING_STATES.includes(requestObjective.state));
    }) ?? null;
  const resolvedActiveSibling =
    activeSiblingObjective ??
    siblings.find(o => o.id === activeSiblingRequest?.objectiveId) ??
    null;
  const hasActiveSibling = Boolean(resolvedActiveSibling);
  const activeSiblingId = resolvedActiveSibling?.id ?? null;
  const activeRequest = executionRequests.find(r => r.objectiveId === objective.id) ?? null;

  function handlePromote() {
    update.mutate({ id: objective.id, body: { state: 'draft' } });
  }

  return (
    <div className="flex shrink-0 flex-nowrap items-center gap-2">
      <DraftObjectiveActions objective={objective} />

      <ObjectiveResourcePicker
        resources={resourcesQ.data ?? []}
        value={objective.resourceKey}
        disabled={update.isPending}
        onChange={resourceKey => update.mutate({ id: objective.id, body: { resourceKey } })}
      />

      <AgentModelChooserButton
        catalog={catalog}
        selection={selection}
        onChange={setSelection}
        agentConfigs={agentConfigs}
        onLaunchConfigCommit={commitLaunchConfig}
      />

      {isFuture ? (
        <Button
          variant="secondary"
          className="h-8 gap-1.5 px-3 text-xs"
          disabled={update.isPending}
          onClick={handlePromote}
        >
          {update.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUpCircle className="h-3.5 w-3.5" />
          )}
          Promote
        </Button>
      ) : isLaunchable ? (
        <AgentLaunchButton
          objective={objective}
          selection={selection}
          selectionLoaded={loaded}
          hasActiveSibling={hasActiveSibling}
          activeSiblingId={activeSiblingId}
          activeRequest={activeRequest}
          size="sm"
        />
      ) : null}
    </div>
  );
}
