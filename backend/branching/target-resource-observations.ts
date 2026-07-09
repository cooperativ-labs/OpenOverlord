import { PERMISSIONS } from '@overlord/auth';

import { recordTargetResourceObservations } from '../../packages/core/service/target-resource-observations.ts';

import { buildWebappServiceContext } from '../db.ts';
import { ApiError } from '../errors.ts';
import { actorCan } from '../rbac.ts';

export async function postExecutionTargetObservations({
  executionTargetId,
  body
}: {
  executionTargetId: string;
  body: unknown;
}): Promise<{ recorded: number }> {
  const canConfigure = await actorCan(PERMISSIONS.LAUNCH_CONFIGURE);
  const canClaim = await actorCan(PERMISSIONS.EXECUTION_REQUEST_CLAIM);
  if (!canConfigure && !canClaim) {
    throw new ApiError(403, 'Not allowed to report resource observations.');
  }

  const payload = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  try {
    return await recordTargetResourceObservations({
      ctx: buildWebappServiceContext(),
      executionTargetId,
      observations: payload.observations
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const serviceError = error as { message: string; code: string; status?: number };
      throw new ApiError(
        serviceError.status ?? 409,
        serviceError.message,
        undefined,
        serviceError.code
      );
    }
    throw error;
  }
}
