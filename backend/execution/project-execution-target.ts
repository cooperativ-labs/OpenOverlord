import { PERMISSIONS } from '@overlord/auth';
import type { DatabaseClient } from '@overlord/database';

import { ServiceError } from '../../packages/core/service/errors.ts';
import {
  deleteWorkspaceExecutionTarget,
  getProjectExecutionTargetSelection,
  listWorkspaceExecutionTargets,
  renameWorkspaceExecutionTarget,
  updateProjectExecutionTargetSelection
} from '../../packages/core/service/project-execution-target.ts';
import type {
  ProjectExecutionTargetDto,
  UpdateProjectExecutionTargetBody,
  WorkspaceExecutionTargetDto
} from '../../webapp/shared/contract.ts';
import {
  buildWebappServiceContext,
  buildWebappServiceContextForWorkspace,
  requireDatabaseClient,
  serviceDatabaseClient
} from '../db.ts';
import { ApiError } from '../errors.ts';
import { requireWorkspacePermission } from '../rbac.ts';

function serviceContext(client: DatabaseClient = serviceDatabaseClient()) {
  return buildWebappServiceContext(client);
}

function toDto(
  selection: Awaited<ReturnType<typeof getProjectExecutionTargetSelection>>
): ProjectExecutionTargetDto {
  return {
    selectedExecutionTargetId: selection.selectedExecutionTargetId,
    eligibleTargets: selection.eligibleTargets.map(target => ({
      executionTargetId: target.executionTargetId,
      type: target.type,
      label: target.label,
      deviceLabel: target.deviceLabel,
      reachable: target.reachable,
      primaryResourceConnected: target.primaryResourceConnected
    }))
  };
}

export async function getProjectExecutionTarget(
  projectId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<ProjectExecutionTargetDto> {
  try {
    return toDto(
      await getProjectExecutionTargetSelection({ ctx: serviceContext(client), projectId })
    );
  } catch (error) {
    if (error instanceof ServiceError && error.status === 404) {
      throw new ApiError(404, 'Project not found');
    }
    throw error;
  }
}

/** Read-only workspace settings projection; access and target mutation stay on their existing flows. */
export async function getWorkspaceExecutionTargets(
  workspaceId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<WorkspaceExecutionTargetDto[]> {
  const workspaceUserId = await requireWorkspacePermission({
    workspaceId,
    permission: PERMISSIONS.WORKSPACE_READ,
    db: client
  });
  const ctx = await buildWebappServiceContextForWorkspace(workspaceId, client, workspaceUserId);
  return listWorkspaceExecutionTargets({ ctx });
}

export async function removeWorkspaceExecutionTarget(
  workspaceId: string,
  executionTargetId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<void> {
  const workspaceUserId = await requireWorkspacePermission({
    workspaceId,
    permission: PERMISSIONS.WORKSPACE_UPDATE,
    db: client
  });
  const ctx = await buildWebappServiceContextForWorkspace(workspaceId, client, workspaceUserId);
  try {
    await deleteWorkspaceExecutionTarget({ ctx, executionTargetId });
  } catch (error) {
    if (error instanceof ServiceError) {
      if (error.status === 404) throw new ApiError(404, 'Execution target not found');
      if (error.status === 409) throw new ApiError(409, error.message, undefined, error.code);
    }
    throw error;
  }
}

export async function updateWorkspaceExecutionTarget(
  workspaceId: string,
  executionTargetId: string,
  body: { label?: unknown },
  client: DatabaseClient = requireDatabaseClient()
): Promise<WorkspaceExecutionTargetDto> {
  const label = typeof body.label === 'string' ? body.label : '';
  const workspaceUserId = await requireWorkspacePermission({
    workspaceId,
    permission: PERMISSIONS.WORKSPACE_UPDATE,
    db: client
  });
  const ctx = await buildWebappServiceContextForWorkspace(workspaceId, client, workspaceUserId);
  try {
    return await renameWorkspaceExecutionTarget({ ctx, executionTargetId, label });
  } catch (error) {
    if (error instanceof ServiceError) {
      if (error.status === 404) throw new ApiError(404, 'Execution target not found');
      if (error.status === 400) throw new ApiError(400, error.message, undefined, error.code);
    }
    throw error;
  }
}

export async function updateProjectExecutionTarget(
  projectId: string,
  body: UpdateProjectExecutionTargetBody,
  client: DatabaseClient = requireDatabaseClient()
): Promise<ProjectExecutionTargetDto> {
  const executionTargetId =
    body.executionTargetId === undefined || body.executionTargetId === null
      ? null
      : body.executionTargetId.trim() || null;

  try {
    return toDto(
      await updateProjectExecutionTargetSelection({
        ctx: serviceContext(client),
        projectId,
        executionTargetId
      })
    );
  } catch (error) {
    if (error instanceof ServiceError) {
      if (error.status === 404) throw new ApiError(404, 'Project not found');
      if (error.status === 409) throw new ApiError(409, error.message);
      if (error.status === 400 && error.code === 'execution_target_not_eligible') {
        throw new ApiError(400, error.message, undefined, error.code);
      }
    }
    throw error;
  }
}
