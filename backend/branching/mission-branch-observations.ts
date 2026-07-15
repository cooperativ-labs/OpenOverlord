import { recordMissionBranchObservations } from '../../packages/core/service/mission-branch-observations.ts';

import {
  requireExecutionTargetObservationContext,
  throwObservationServiceError
} from './execution-target-observation-scope.ts';

export async function postMissionBranchObservations({
  executionTargetId,
  body
}: {
  executionTargetId: string;
  body: unknown;
}): Promise<{ recorded: number }> {
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  try {
    return await recordMissionBranchObservations({
      ctx: await requireExecutionTargetObservationContext(
        executionTargetId,
        'Not allowed to report mission branch observations.'
      ),
      executionTargetId,
      observations: payload.observations
    });
  } catch (error) {
    throwObservationServiceError(error);
  }
}
