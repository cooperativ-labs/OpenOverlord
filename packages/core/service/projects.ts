import { bindBool } from '@overlord/database';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  deriveResourceStatus,
  isCoLocatedBackend,
  readProjectJsonLink,
  resolveBackendResourceProvider
} from './local-target/index.ts';
import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { resolveProjectId } from './context.js';
import { ServiceError } from './errors.js';
import { ensureActingDeviceTarget } from './execution-targets.js';
import { deriveProjectResourceKey } from './project-resource-key.js';
import { newId, nowIso, slugify } from './util.js';

export { deriveProjectResourceKey } from './project-resource-key.js';

export type ProjectSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectResourceSummary = {
  id: string;
  projectId: string;
  resourceKey: string;
  type: string;
  label: string | null;
  path: string;
  isPrimary: boolean;
  status: string;
  executionTargetId?: string | null;
};

export const PRIMARY_RESOURCE_REPAIR_HINT =
  'Run `ovld add-cwd` from your project checkout or link a directory in project settings.';

export function objectiveResourceRepairHint(resourceKey: string): string {
  return `Run \`ovld add-cwd --key ${resourceKey}\` from the intended checkout on this device.`;
}

export type PrimaryResourceConnection = {
  resource: ProjectResourceSummary;
  workingDirectory: string;
};

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1;
}

/**
 * Resolve the provider that observes resource availability for the backend:
 * in-process when the backend is co-located with the checkout (Local SQLite),
 * otherwise an unavailable provider so status falls back to recorded lifecycle.
 */
function backendResourceProvider(ctx: ServiceContext, executionTargetId: string | null) {
  return resolveBackendResourceProvider(isCoLocatedBackend(ctx.db), {
    executionTargetId,
    deviceLabel: null,
    transport: 'in_process'
  });
}

export type ProjectDiscovery = {
  projectId: string;
  projectName: string;
  resourceId: string | null;
  resourcePath: string | null;
  isPrimary: boolean;
};

async function preferredExecutionTargetIdForDiscovery({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<string | null> {
  try {
    return (await ensureActingDeviceTarget({ ctx })).executionTargetId;
  } catch {
    return null;
  }
}

export async function createProject({
  ctx,
  name,
  description,
  slug: slugInput
}: {
  ctx: ServiceContext;
  name: string;
  description?: string | null;
  slug?: string | null;
}): Promise<ProjectSummary> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new ServiceError('Project name is required', 'validation_error');
  }

  const now = nowIso();
  const id = newId();
  const slug = slugInput?.trim() ? slugify(slugInput) : slugify(trimmedName);

  await ctx.db.transaction(async tx => {
    const txCtx = { ...ctx, db: tx };
    const maxPosition = (await tx.get(
      `SELECT COALESCE(MAX(position), 0) AS max_position FROM projects
          WHERE workspace_id = ? AND deleted_at IS NULL`,
      [ctx.workspace.id]
    )) as { max_position: number };
    const position = maxPosition.max_position + 1;
    await txCtx.db.run(
      `INSERT INTO projects
           (id, workspace_id, slug, name, description, status, settings_json,
            created_by_workspace_user_id, created_at, updated_at, revision, position)
         VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?, ?, 1, ?)`,
      [
        id,
        ctx.workspace.id,
        slug,
        trimmedName,
        description?.trim() || null,
        ctx.actorWorkspaceUserId,
        now,
        now,
        position
      ]
    );

    // Card statuses are configured once per workspace (see `workspace_statuses`),
    // so project creation no longer seeds its own status set.

    await recordChange({
      ctx: txCtx,
      entityType: 'project',
      entityId: id,
      operation: 'insert',
      entityRevision: 1,
      projectId: id
    });
  });
  return await getProject({ ctx, projectId: id });
}

export async function getProject({
  ctx,
  projectId
}: {
  ctx: ServiceContext;
  projectId: string;
}): Promise<ProjectSummary> {
  const id = await resolveProjectId(ctx, projectId);
  const row = (await ctx.db.get(
    `SELECT id, slug, name, description, status, created_at, updated_at
       FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [id, ctx.workspace.id]
  )) as
    | {
        id: string;
        slug: string;
        name: string;
        description: string | null;
        status: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    throw new ServiceError('Project not found', 'project_not_found', 404);
  }

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listProjects({ ctx }: { ctx: ServiceContext }): Promise<ProjectSummary[]> {
  const rows = (await ctx.db.all(
    `SELECT id, slug, name, description, status, created_at, updated_at
       FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
       ORDER BY created_at ASC`,
    [ctx.workspace.id]
  )) as Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    status: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function addProjectResource({
  ctx,
  projectId,
  directoryPath,
  resourceKey,
  label,
  isPrimary = false
}: {
  ctx: ServiceContext;
  projectId: string;
  directoryPath: string;
  resourceKey?: string | null;
  label?: string | null;
  isPrimary?: boolean;
}): Promise<ProjectResourceSummary> {
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const resolvedPath = path.resolve(directoryPath);
  const resolvedResourceKey = deriveProjectResourceKey({ resourceKey, label, directoryPath });
  const executionTargetId = (await ensureActingDeviceTarget({ ctx })).executionTargetId;
  const now = nowIso();
  const id = newId();

  if (isPrimary) {
    await ctx.db.run(
      `UPDATE project_resources SET is_primary = ?, updated_at = ?, revision = revision + 1
         WHERE project_id = ? AND deleted_at IS NULL AND is_primary = ? AND execution_target_id = ?`,
      [
        bindBool(ctx.db.dialect, false),
        now,
        resolvedProjectId,
        bindBool(ctx.db.dialect, true),
        executionTargetId
      ]
    );
  }

  await ctx.db.run(
    `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, resource_key, type, label, path, is_primary, status,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, 'local_directory', ?, ?, ?, 'active', '{}', ?, ?, 1)`,
    [
      id,
      ctx.workspace.id,
      resolvedProjectId,
      executionTargetId,
      resolvedResourceKey,
      label?.trim() || path.basename(resolvedPath),
      resolvedPath,
      bindBool(ctx.db.dialect, isPrimary),
      now,
      now
    ]
  );

  // WS-D 2: write .overlord/project.json through the capability. A co-located
  // backend resolves an in-process provider and writes; a hosted backend resolves
  // an unavailable provider and writes nothing (the CLI/Desktop client owns the
  // write on its own machine).
  await backendResourceProvider(ctx, executionTargetId).writeProjectMetadata({
    directoryPath: resolvedPath,
    projectId: resolvedProjectId,
    resourceId: id,
    resourceKey: resolvedResourceKey,
    executionTargetId,
    isPrimary
  });

  await recordChange({
    ctx,
    entityType: 'project_resource',
    entityId: id,
    operation: 'insert',
    entityRevision: 1,
    projectId: resolvedProjectId
  });

  return {
    id,
    projectId: resolvedProjectId,
    executionTargetId,
    resourceKey: resolvedResourceKey,
    type: 'local_directory',
    label: label?.trim() || path.basename(resolvedPath),
    path: resolvedPath,
    isPrimary,
    status: 'active'
  };
}

export async function listProjectResources({
  ctx,
  projectId
}: {
  ctx: ServiceContext;
  projectId: string;
}): Promise<ProjectResourceSummary[]> {
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const rows = (await ctx.db.all(
    `SELECT id, project_id, execution_target_id, resource_key, type, label, path, is_primary, status
       FROM project_resources
       WHERE project_id = ? AND deleted_at IS NULL
       ORDER BY is_primary DESC, created_at ASC`,
    [resolvedProjectId]
  )) as ProjectResourceRow[];

  return await Promise.all(rows.map(row => rowToProjectResourceSummary(ctx, row)));
}

/**
 * Single-row lookup shared by the primary/key resource finders. A row scoped to
 * `executionTargetId` wins over a global (NULL-target) row, then creation order
 * breaks ties — the same precedence launch resolution uses.
 */
async function findProjectResourceRow({
  ctx,
  projectId,
  resourceKey = null,
  primaryOnly = false,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  resourceKey?: string | null;
  primaryOnly?: boolean;
  executionTargetId?: string | null;
}): Promise<ProjectResourceRow | undefined> {
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const conditions = ['project_id = ?', 'deleted_at IS NULL'];
  const params: unknown[] = [resolvedProjectId];
  if (primaryOnly) {
    conditions.push('is_primary = ?');
    params.push(bindBool(ctx.db.dialect, true));
  }
  if (resourceKey !== null) {
    conditions.push('resource_key = ?');
    params.push(resourceKey);
  }
  const orderBy: string[] = [];
  if (executionTargetId !== null) {
    conditions.push('(execution_target_id = ? OR execution_target_id IS NULL)');
    params.push(executionTargetId);
    orderBy.push('CASE WHEN execution_target_id = ? THEN 0 ELSE 1 END');
    params.push(executionTargetId);
  }
  orderBy.push('created_at ASC');

  return (await ctx.db.get(
    `SELECT id, project_id, execution_target_id, resource_key, type, label, path, is_primary, status
       FROM project_resources
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy.join(', ')}
      LIMIT 1`,
    params
  )) as ProjectResourceRow | undefined;
}

export async function findPrimaryProjectResource({
  ctx,
  projectId,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  executionTargetId?: string | null;
}): Promise<ProjectResourceSummary | null> {
  const row = await findProjectResourceRow({
    ctx,
    projectId,
    primaryOnly: true,
    executionTargetId
  });
  return row ? await rowToProjectResourceSummary(ctx, row) : null;
}

export async function assertPrimaryResourceConnected({
  ctx,
  projectId,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  executionTargetId?: string | null;
}): Promise<PrimaryResourceConnection> {
  const primary = await findPrimaryProjectResource({ ctx, projectId, executionTargetId });
  if (!primary) {
    throw new ServiceError(
      `No primary resource is linked for this project. ${PRIMARY_RESOURCE_REPAIR_HINT}`,
      'primary_resource_not_connected',
      409
    );
  }
  if (primary.status === 'missing') {
    throw new ServiceError(
      `Primary working directory is missing (${primary.path}). ${PRIMARY_RESOURCE_REPAIR_HINT}`,
      'primary_resource_not_connected',
      409
    );
  }
  if (primary.type !== 'local_directory') {
    throw new ServiceError(
      `Primary resource type "${primary.type}" is not supported for local agent runs yet.`,
      'primary_resource_not_connected',
      409
    );
  }

  return {
    resource: primary,
    workingDirectory: path.resolve(primary.path)
  };
}

type ProjectResourceRow = {
  id: string;
  project_id: string;
  execution_target_id: string | null;
  resource_key: string;
  type: string;
  label: string | null;
  path: string;
  is_primary: boolean | number;
  status: string;
};

function rowToProjectResourceSummary(
  ctx: ServiceContext,
  row: ProjectResourceRow
): Promise<ProjectResourceSummary> {
  return deriveResourceStatus(backendResourceProvider(ctx, row.execution_target_id), {
    resourceId: row.id,
    status: row.status,
    path: row.path
  }).then(status => ({
    id: row.id,
    projectId: row.project_id,
    executionTargetId: row.execution_target_id,
    resourceKey: row.resource_key,
    type: row.type,
    label: row.label,
    path: row.path,
    isPrimary: isTruthyFlag(row.is_primary),
    status
  }));
}

export async function projectHasResourceKey({
  ctx,
  projectId,
  resourceKey
}: {
  ctx: ServiceContext;
  projectId: string;
  resourceKey: string;
}): Promise<boolean> {
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const normalizedKey = resourceKey.trim();
  if (!normalizedKey) return false;
  const row = (await ctx.db.get(
    `SELECT 1 AS ok FROM project_resources
        WHERE project_id = ? AND resource_key = ? AND deleted_at IS NULL
        LIMIT 1`,
    [resolvedProjectId, normalizedKey]
  )) as { ok: number } | undefined;
  return Boolean(row);
}

export async function assertProjectResourceKeyExists({
  ctx,
  projectId,
  resourceKey
}: {
  ctx: ServiceContext;
  projectId: string;
  resourceKey: string;
}): Promise<void> {
  const normalizedKey = resourceKey.trim();
  if (!normalizedKey) return;
  const exists = await projectHasResourceKey({ ctx, projectId, resourceKey: normalizedKey });
  if (!exists) {
    throw new ServiceError(
      `Project resource key "${normalizedKey}" is not linked to this project.`,
      'project_resource_key_not_found',
      409
    );
  }
}

export async function findProjectResourceByKey({
  ctx,
  projectId,
  resourceKey,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  resourceKey: string;
  executionTargetId?: string | null;
}): Promise<ProjectResourceSummary | null> {
  const normalizedKey = resourceKey.trim();
  if (!normalizedKey) return null;

  const row = await findProjectResourceRow({
    ctx,
    projectId,
    resourceKey: normalizedKey,
    executionTargetId
  });
  return row ? await rowToProjectResourceSummary(ctx, row) : null;
}

export async function assertObjectiveResourceConnected({
  ctx,
  projectId,
  resourceKey,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  resourceKey: string;
  executionTargetId?: string | null;
}): Promise<PrimaryResourceConnection> {
  const normalizedKey = resourceKey.trim();
  const resource = await findProjectResourceByKey({
    ctx,
    projectId,
    resourceKey: normalizedKey,
    executionTargetId
  });
  if (!resource) {
    throw new ServiceError(
      `Objective resource "${normalizedKey}" is not linked on this execution target. ${objectiveResourceRepairHint(normalizedKey)}`,
      'objective_resource_not_connected',
      409
    );
  }
  if (resource.status === 'missing') {
    throw new ServiceError(
      `Objective resource "${normalizedKey}" working directory is missing (${resource.path}). ${objectiveResourceRepairHint(normalizedKey)}`,
      'objective_resource_not_connected',
      409
    );
  }
  if (resource.type !== 'local_directory') {
    throw new ServiceError(
      `Objective resource "${normalizedKey}" type "${resource.type}" is not supported for local agent runs yet.`,
      'objective_resource_not_connected',
      409
    );
  }

  return {
    resource,
    workingDirectory: path.resolve(resource.path)
  };
}

export async function resolveCwdProjectResource({
  ctx,
  projectId,
  executionTargetId = null,
  workingDirectory = process.cwd()
}: {
  ctx: ServiceContext;
  projectId: string;
  executionTargetId?: string | null;
  workingDirectory?: string;
}): Promise<PrimaryResourceConnection | null> {
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  // Prefer the caller's launch target when picking among multi-target
  // project.json links; fall back to the acting device.
  const preferredExecutionTargetId =
    executionTargetId ?? (await preferredExecutionTargetIdForDiscovery({ ctx }));
  let current = path.resolve(workingDirectory);

  while (true) {
    const projectJsonPath = path.join(current, '.overlord', 'project.json');
    try {
      const raw = readProjectJsonLink(projectJsonPath, { preferredExecutionTargetId });
      if (raw?.projectId === resolvedProjectId) {
        const row = (await ctx.db.get(
          `SELECT id, project_id, execution_target_id, resource_key, type, label, path, is_primary, status
             FROM project_resources
            WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
          [raw.resourceId, resolvedProjectId]
        )) as ProjectResourceRow | undefined;
        if (!row || row.type !== 'local_directory') return null;
        const resource = await rowToProjectResourceSummary(ctx, row);
        if (resource.status === 'missing') return null;
        return {
          resource,
          workingDirectory: path.resolve(resource.path)
        };
      }
    } catch {
      // continue walking up
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

export async function resolveObjectiveWorkingDirectory({
  ctx,
  projectId,
  objectiveResourceKey = null,
  explicitWorkingDirectory,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  objectiveResourceKey?: string | null;
  explicitWorkingDirectory?: string | null;
  executionTargetId?: string | null;
}): Promise<{ workingDirectory: string; resourceId: string | null }> {
  if (explicitWorkingDirectory?.trim()) {
    const resolved = path.resolve(explicitWorkingDirectory);
    if (ctx.db.dialect === 'sqlite' && !existsSync(resolved)) {
      throw new ServiceError(
        `Working directory does not exist: ${resolved}`,
        'working_directory_missing'
      );
    }
    return { workingDirectory: resolved, resourceId: null };
  }

  const boundKey = objectiveResourceKey?.trim();
  if (boundKey) {
    const connected = await assertObjectiveResourceConnected({
      ctx,
      projectId,
      resourceKey: boundKey,
      executionTargetId
    });
    return {
      workingDirectory: connected.workingDirectory,
      resourceId: connected.resource.id
    };
  }

  try {
    const connected = await assertPrimaryResourceConnected({ ctx, projectId, executionTargetId });
    return {
      workingDirectory: connected.workingDirectory,
      resourceId: connected.resource.id
    };
  } catch (error) {
    if (!(error instanceof ServiceError) || error.code !== 'primary_resource_not_connected') {
      throw error;
    }
    const cwdResource = await resolveCwdProjectResource({
      ctx,
      projectId,
      executionTargetId
    });
    if (cwdResource) {
      return {
        workingDirectory: cwdResource.workingDirectory,
        resourceId: cwdResource.resource.id
      };
    }
    throw error;
  }
}

export async function assertLaunchResourceConnected({
  ctx,
  projectId,
  objectiveResourceKey = null,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  objectiveResourceKey?: string | null;
  executionTargetId?: string | null;
}): Promise<PrimaryResourceConnection> {
  const boundKey = objectiveResourceKey?.trim();
  if (boundKey) {
    return assertObjectiveResourceConnected({
      ctx,
      projectId,
      resourceKey: boundKey,
      executionTargetId
    });
  }
  return assertPrimaryResourceConnected({ ctx, projectId, executionTargetId });
}

export async function discoverProject({
  ctx,
  workingDirectory,
  projectId
}: {
  ctx: ServiceContext;
  workingDirectory?: string | null;
  projectId?: string | null;
}): Promise<ProjectDiscovery> {
  if (projectId) {
    const resolvedProjectId = await resolveProjectId(ctx, projectId);
    const project = await getProject({ ctx, projectId: resolvedProjectId });
    const resources = await listProjectResources({ ctx, projectId: resolvedProjectId });
    const primary = resources.find(r => r.isPrimary) ?? resources[0];
    return {
      projectId: project.id,
      projectName: project.name,
      resourceId: primary?.id ?? null,
      resourcePath: primary?.path ?? null,
      isPrimary: primary?.isPrimary ?? false
    };
  }

  const cwd = path.resolve(workingDirectory ?? process.cwd());
  let current = cwd;
  const preferredExecutionTargetId = await preferredExecutionTargetIdForDiscovery({ ctx });

  while (true) {
    const projectJsonPath = path.join(current, '.overlord', 'project.json');
    try {
      const raw = readProjectJsonLink(projectJsonPath, { preferredExecutionTargetId });
      if (raw) {
        const project = await getProject({ ctx, projectId: raw.projectId });
        const resource = (await ctx.db.get(
          `SELECT id, path, is_primary FROM project_resources
             WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
          [raw.resourceId, raw.projectId]
        )) as { id: string; path: string; is_primary: boolean | number } | undefined;

        return {
          projectId: project.id,
          projectName: project.name,
          resourceId: resource?.id ?? raw.resourceId,
          resourcePath: resource?.path ?? current,
          isPrimary: resource ? isTruthyFlag(resource.is_primary) : raw.isPrimary
        };
      }
    } catch {
      // continue walking up
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new ServiceError(
    `No linked Overlord project found for ${cwd}. Run \`ovld add-cwd\` or \`ovld create-project\`.`,
    'project_not_found',
    404
  );
}

export function listOrganizations({ ctx }: { ctx: ServiceContext }): Array<{
  id: string;
  slug: string;
  name: string;
}> {
  return [
    {
      id: ctx.workspace.id,
      slug: ctx.workspace.slug,
      name: ctx.workspace.name
    }
  ];
}
