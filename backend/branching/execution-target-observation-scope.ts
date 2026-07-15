import { PERMISSIONS } from '@overlord/auth';

import {
  buildWebappServiceContextForWorkspace,
  findActiveMembershipId,
  requireDatabaseClient,
  resolveActiveProfileId
} from '../db.ts';
import { ApiError } from '../errors.ts';
import { actorCan } from '../rbac.ts';

export async function requireExecutionTargetObservationContext(
  executionTargetId: string,
  deniedMessage: string
) {
  const db = requireDatabaseClient();
  const target = await db.get<{ workspace_id: string }>(
    `SELECT workspace_id FROM execution_targets WHERE id = ? AND deleted_at IS NULL`,
    [executionTargetId]
  );
  if (!target) throw new ApiError(404, 'Execution target not found');

  const profileId = await resolveActiveProfileId(db);
  const workspaceUserId = profileId
    ? await findActiveMembershipId(target.workspace_id, profileId, db)
    : null;
  if (!workspaceUserId) throw new ApiError(403, deniedMessage);

  const scope = { workspaceId: target.workspace_id, workspaceUserId };
  const allowed =
    (await actorCan(PERMISSIONS.LAUNCH_CONFIGURE, scope)) ||
    (await actorCan(PERMISSIONS.EXECUTION_REQUEST_CLAIM, scope));
  if (!allowed) throw new ApiError(403, deniedMessage);

  return buildWebappServiceContextForWorkspace(target.workspace_id, db, workspaceUserId);
}

export function throwObservationServiceError(error: unknown): never {
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
