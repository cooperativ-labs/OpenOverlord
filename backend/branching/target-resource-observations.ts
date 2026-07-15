import { recordTargetResourceObservations } from '../../packages/core/service/target-resource-observations.ts';

import {
  requireExecutionTargetObservationContext,
  throwObservationServiceError
} from './execution-target-observation-scope.ts';

export async function postExecutionTargetObservations({
  executionTargetId,
  body
}: {
  executionTargetId: string;
  body: unknown;
}): Promise<{ recorded: number }> {
  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  try {
    return await recordTargetResourceObservations({
      ctx: await requireExecutionTargetObservationContext(
        executionTargetId,
        'Not allowed to report resource observations.'
      ),
      executionTargetId,
      observations: payload.observations
    });
  } catch (error) {
    throwObservationServiceError(error);
  }
}
