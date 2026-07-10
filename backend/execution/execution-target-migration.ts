import { PERMISSIONS } from '@overlord/auth';

import { loadExecutionTargetMigrationDiagnostics } from '../../packages/core/service/execution-target-migration.ts';
import { buildWebappServiceContext } from '../db.ts';
import { ApiError } from '../errors.ts';
import { actorCan } from '../rbac.ts';

export async function getExecutionTargetMigrationDiagnostics() {
  const canRead = await actorCan(PERMISSIONS.WORKSPACE_READ);
  if (!canRead) {
    throw new ApiError(403, 'Not allowed to read execution-target migration diagnostics.');
  }

  return loadExecutionTargetMigrationDiagnostics({
    ctx: buildWebappServiceContext()
  });
}
