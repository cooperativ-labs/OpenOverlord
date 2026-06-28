import { bindBool } from '@overlord/database';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { resolveProjectId } from './context.js';
import { ServiceError } from './errors.js';
import { ensureCallerDeviceTarget } from './execution-targets.js';
import { initialTitleFromInstruction, newId, nowIso, slugify } from './util.js';

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
  type: string;
  label: string | null;
  path: string;
  isPrimary: boolean;
  status: string;
  executionTargetId?: string | null;
};

export const PRIMARY_RESOURCE_REPAIR_HINT =
  'Run `ovld add-cwd` from your project checkout or link a directory in project settings.';

export type PrimaryResourceConnection = {
  resource: ProjectResourceSummary;
  workingDirectory: string;
};

function effectiveResourceStatus(
  resource: { status: string; path: string },
  canAccessLinkedFilesystem = true
): string {
  if (resource.status === 'archived') return 'archived';
  if (!canAccessLinkedFilesystem) return resource.status;
  return existsSync(resource.path) ? 'active' : 'missing';
}

export type ProjectDiscovery = {
  projectId: string;
  projectName: string;
  resourceId: string | null;
  resourcePath: string | null;
  isPrimary: boolean;
};

const PROJECT_JSON_VERSION = 1;

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
    await txCtx.db.run(
      `INSERT INTO projects
           (id, workspace_id, slug, name, description, status, settings_json,
            created_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?, ?, 1)`,
      [
        id,
        ctx.workspace.id,
        slug,
        trimmedName,
        description?.trim() || null,
        ctx.actorWorkspaceUserId,
        now,
        now
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
  label,
  isPrimary = false
}: {
  ctx: ServiceContext;
  projectId: string;
  directoryPath: string;
  label?: string | null;
  isPrimary?: boolean;
}): Promise<ProjectResourceSummary> {
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const resolvedPath = path.resolve(directoryPath);
  const executionTargetId = (await ensureCallerDeviceTarget({ ctx })).executionTargetId;
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
         (id, workspace_id, project_id, execution_target_id, type, label, path, is_primary, status,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local_directory', ?, ?, ?, 'active', '{}', ?, ?, 1)`,
    [
      id,
      ctx.workspace.id,
      resolvedProjectId,
      executionTargetId,
      label?.trim() || path.basename(resolvedPath),
      resolvedPath,
      bindBool(ctx.db.dialect, isPrimary),
      now,
      now
    ]
  );

  writeProjectJson({
    directoryPath: resolvedPath,
    projectId: resolvedProjectId,
    resourceId: id,
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
    `SELECT id, project_id, execution_target_id, type, label, path, is_primary, status
       FROM project_resources
       WHERE project_id = ? AND deleted_at IS NULL
       ORDER BY is_primary DESC, created_at ASC`,
    [resolvedProjectId]
  )) as Array<{
    id: string;
    project_id: string;
    execution_target_id: string | null;
    type: string;
    label: string | null;
    path: string;
    is_primary: number;
    status: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    executionTargetId: row.execution_target_id,
    type: row.type,
    label: row.label,
    path: row.path,
    isPrimary: row.is_primary === 1,
    status: effectiveResourceStatus(row, ctx.db.dialect === 'sqlite')
  }));
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
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const targetPredicate =
    executionTargetId === null
      ? ''
      : 'AND (execution_target_id = @execution_target_id OR execution_target_id IS NULL)';
  const row = (await ctx.db.get(
    `SELECT id, project_id, execution_target_id, type, label, path, is_primary, status
       FROM project_resources
       WHERE project_id = @project_id
         AND deleted_at IS NULL
         AND is_primary = @is_primary
         ${targetPredicate}
       ORDER BY
         CASE WHEN execution_target_id = @execution_target_id THEN 0 ELSE 1 END,
         created_at ASC
       LIMIT 1`,
    [
      {
        project_id: resolvedProjectId,
        execution_target_id: executionTargetId,
        is_primary: bindBool(ctx.db.dialect, true)
      }
    ]
  )) as
    | {
        id: string;
        project_id: string;
        execution_target_id: string | null;
        type: string;
        label: string | null;
        path: string;
        is_primary: number;
        status: string;
      }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    projectId: row.project_id,
    executionTargetId: row.execution_target_id,
    type: row.type,
    label: row.label,
    path: row.path,
    isPrimary: true,
    status: effectiveResourceStatus(row, ctx.db.dialect === 'sqlite')
  };
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

  while (true) {
    const projectJsonPath = path.join(current, '.overlord', 'project.json');
    try {
      const raw = readProjectJsonFile(projectJsonPath);
      if (raw) {
        const project = await getProject({ ctx, projectId: raw.projectId });
        const resource = (await ctx.db.get(
          `SELECT id, path, is_primary FROM project_resources
             WHERE id = ? AND project_id = ? AND deleted_at IS NULL`,
          [raw.resourceId, raw.projectId]
        )) as { id: string; path: string; is_primary: number } | undefined;

        return {
          projectId: project.id,
          projectName: project.name,
          resourceId: resource?.id ?? raw.resourceId,
          resourcePath: resource?.path ?? current,
          isPrimary: resource ? resource.is_primary === 1 : raw.isPrimary
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

function readProjectJsonFile(projectJsonPath: string): {
  projectId: string;
  resourceId: string;
  isPrimary: boolean;
} | null {
  if (!existsSync(projectJsonPath)) return null;
  const parsed = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as {
    projectId?: string;
    resourceId?: string;
    isPrimary?: boolean;
  };
  if (!parsed.projectId || !parsed.resourceId) return null;
  return {
    projectId: parsed.projectId,
    resourceId: parsed.resourceId,
    isPrimary: parsed.isPrimary ?? false
  };
}

export function writeProjectJson({
  directoryPath,
  projectId,
  resourceId,
  isPrimary
}: {
  directoryPath: string;
  projectId: string;
  resourceId: string;
  isPrimary: boolean;
}): void {
  const overlordDir = path.join(directoryPath, '.overlord');
  mkdirSync(overlordDir, { recursive: true });
  mkdirSync(path.join(overlordDir, 'tmp'), { recursive: true });
  mkdirSync(path.join(overlordDir, 'logs'), { recursive: true });

  writeFileSync(
    path.join(overlordDir, 'project.json'),
    `${JSON.stringify(
      {
        version: PROJECT_JSON_VERSION,
        projectId,
        resourceId,
        isPrimary,
        linkedAt: nowIso()
      },
      null,
      2
    )}\n`
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
