import type {
  MissionBranchDto,
  MissionBranchObservationInput,
  MissionBranchStatus
} from '../../shared/contract.ts';

import { api } from './api.ts';

function isRecordedMissionBranchStatus(
  status: MissionBranchStatus
): status is MissionBranchObservationInput['status'] {
  return status !== 'pending';
}

export async function reportMissionBranchObservation({
  executionTargetId,
  missionId,
  branch
}: {
  executionTargetId: string;
  missionId: string;
  branch: MissionBranchDto;
}): Promise<number> {
  if (!isRecordedMissionBranchStatus(branch.status)) return 0;
  const observedAt = branch.observedAt ?? new Date().toISOString();
  const observation: MissionBranchObservationInput = {
    missionId,
    resourceKey: resource.resourceKey,
    status: branch.status,
    dirty: branch.dirty,
    worktreePath: branch.worktreePath,
    observedAt
  };
  const response = await api.recordMissionBranchObservations(executionTargetId, {
    observations: [observation]
  });
  return response.recorded;
}
