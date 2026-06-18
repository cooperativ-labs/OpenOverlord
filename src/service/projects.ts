import { DEFAULT_STATUSES } from '@overlord/database';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { resolveProjectId } from './context.js';
import { ServiceError } from './errors.js';
import { ensureLocalExecutionTarget } from './execution-targets.js';
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

function effectiveResourceStatus(resource: { status: string; path: string }): string {
  if (resource.status === 'archived') return 'archived';
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

export function createProject({
  ctx,
  name,
  description,
  slug: slugInput
}: {
  ctx: ServiceContext;
  name: string;
  description?: string | null;
  slug?: string | null;
}): ProjectSummary {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new ServiceError('Project name is required', 'validation_error');
  }

  const now = nowIso();
  const id = newId();
  const slug = slugInput?.trim() ? slugify(slugInput) : slugify(trimmedName);

  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `INSERT INTO projects
           (id, workspace_id, slug, name, description, status, settings_json,
            created_by_workspace_user_id, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, 'active', '{}', ?, ?, ?, 1)`
      )
      .run(
        id,
        ctx.workspace.id,
        slug,
        trimmedName,
        description?.trim() || null,
        ctx.actorWorkspaceUserId,
        now,
        now
      );

    const insertStatus = ctx.db.prepare(
      `INSERT INTO project_statuses
         (id, workspace_id, project_id, key, name, type, position, is_default, is_terminal,
          created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );

    for (const status of DEFAULT_STATUSES) {
      insertStatus.run(
        newId(),
        ctx.workspace.id,
        id,
        status.key,
        status.name,
        status.type,
        status.position,
        status.isDefault ? 1 : 0,
        status.isTerminal ? 1 : 0,
        now,
        now
      );
    }

    recordChange({
      ctx,
      entityType: 'project',
      entityId: id,
      operation: 'insert',
      entityRevision: 1,
      projectId: id
    });
  });

  tx();
  return getProject({ ctx, projectId: id });
}

export function getProject({
  ctx,
  projectId
}: {
  ctx: ServiceContext;
  projectId: string;
}): ProjectSummary {
  const id = resolveProjectId(ctx, projectId);
  const row = ctx.db
    .prepare(
      `SELECT id, slug, name, description, status, created_at, updated_at
       FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(id, ctx.workspace.id) as
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

export function listProjects({ ctx }: { ctx: ServiceContext }): ProjectSummary[] {
  const rows = ctx.db
    .prepare(
      `SELECT id, slug, name, description, status, created_at, updated_at
       FROM projects WHERE workspace_id = ? AND deleted_at IS NULL
       ORDER BY created_at ASC`
    )
    .all(ctx.workspace.id) as Array<{
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

export function addProjectResource({
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
}): ProjectResourceSummary {
  const resolvedProjectId = resolveProjectId(ctx, projectId);
  const resolvedPath = path.resolve(directoryPath);
  const executionTargetId = ensureLocalExecutionTarget({ ctx }).executionTargetId;
  const now = nowIso();
  const id = newId();

  if (isPrimary) {
    ctx.db
      .prepare(
        `UPDATE project_resources SET is_primary = 0, updated_at = ?, revision = revision + 1
         WHERE project_id = ? AND deleted_at IS NULL AND is_primary = 1 AND execution_target_id = ?`
      )
      .run(now, resolvedProjectId, executionTargetId);
  }

  ctx.db
    .prepare(
      `INSERT INTO project_resources
         (id, workspace_id, project_id, execution_target_id, type, label, path, is_primary, status,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local_directory', ?, ?, ?, 'active', '{}', ?, ?, 1)`
    )
    .run(
      id,
      ctx.workspace.id,
      resolvedProjectId,
      executionTargetId,
      label?.trim() || path.basename(resolvedPath),
      resolvedPath,
      isPrimary ? 1 : 0,
      now,
      now
    );

  writeProjectJson({
    directoryPath: resolvedPath,
    projectId: resolvedProjectId,
    resourceId: id,
    isPrimary
  });

  recordChange({
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

export function listProjectResources({
  ctx,
  projectId
}: {
  ctx: ServiceContext;
  projectId: string;
}): ProjectResourceSummary[] {
  const resolvedProjectId = resolveProjectId(ctx, projectId);
  const rows = ctx.db
    .prepare(
      `SELECT id, project_id, execution_target_id, type, label, path, is_primary, status
       FROM project_resources
       WHERE project_id = ? AND deleted_at IS NULL
       ORDER BY is_primary DESC, created_at ASC`
    )
    .all(resolvedProjectId) as Array<{
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
    status: effectiveResourceStatus(row)
  }));
}

export function findPrimaryProjectResource({
  ctx,
  projectId,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  executionTargetId?: string | null;
}): ProjectResourceSummary | null {
  const resolvedProjectId = resolveProjectId(ctx, projectId);
  const targetPredicate =
    executionTargetId === null
      ? ''
      : 'AND (execution_target_id = @execution_target_id OR execution_target_id IS NULL)';
  const row = ctx.db
    .prepare(
      `SELECT id, project_id, execution_target_id, type, label, path, is_primary, status
       FROM project_resources
       WHERE project_id = @project_id
         AND deleted_at IS NULL
         AND is_primary = 1
         ${targetPredicate}
       ORDER BY
         CASE WHEN execution_target_id = @execution_target_id THEN 0 ELSE 1 END,
         created_at ASC
       LIMIT 1`
    )
    .get({ project_id: resolvedProjectId, execution_target_id: executionTargetId }) as
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
    status: effectiveResourceStatus(row)
  };
}

export function assertPrimaryResourceConnected({
  ctx,
  projectId,
  executionTargetId = null
}: {
  ctx: ServiceContext;
  projectId: string;
  executionTargetId?: string | null;
}): PrimaryResourceConnection {
  const primary = findPrimaryProjectResource({ ctx, projectId, executionTargetId });
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

export function discoverProject({
  ctx,
  workingDirectory,
  projectId
}: {
  ctx: ServiceContext;
  workingDirectory?: string | null;
  projectId?: string | null;
}): ProjectDiscovery {
  if (projectId) {
    const resolvedProjectId = resolveProjectId(ctx, projectId);
    const project = getProject({ ctx, projectId: resolvedProjectId });
    const resources = listProjectResources({ ctx, projectId: resolvedProjectId });
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
        const project = getProject({ ctx, projectId: raw.projectId });
        const resource = ctx.db
          .prepare(
            `SELECT id, path, is_primary FROM project_resources
             WHERE id = ? AND project_id = ? AND deleted_at IS NULL`
          )
          .get(raw.resourceId, raw.projectId) as
          | { id: string; path: string; is_primary: number }
          | undefined;

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
