import type { ServiceContext } from './context.js';
import { resolveProjectId } from './context.js';
import { findPrimaryProjectResource } from './projects.js';
import { loadTargetResourceObservations } from './target-resource-observations.js';

export type ProjectResourceManifestEntry = {
  resourceKey: string;
  label: string | null;
  isPrimary: boolean;
  isCurrent: boolean;
  path: string | null;
  state: string;
};

type ResourceLike = {
  id?: string;
  resourceKey: string;
  label: string | null;
  path: string;
  isPrimary: boolean;
  status: string;
  executionTargetId: string | null;
};

function isTruthyPrimary(value: boolean | number): boolean {
  return value === true || value === 1;
}

function pickResourceForTarget<T extends ResourceLike>(
  resources: T[],
  executionTargetId: string | null
): T | null {
  if (resources.length === 0) return null;
  if (!executionTargetId) return resources[0] ?? null;
  const exact = resources.find(resource => resource.executionTargetId === executionTargetId);
  if (exact) return exact;
  const global = resources.find(resource => resource.executionTargetId === null);
  return global ?? resources[0] ?? null;
}

export function buildProjectResourceManifestEntries({
  resources,
  executionTargetId,
  currentResourceKey,
  observationStatesByResourceId = new Map<string, string>()
}: {
  resources: ResourceLike[];
  executionTargetId: string | null;
  currentResourceKey: string | null;
  observationStatesByResourceId?: Map<string, string>;
}): ProjectResourceManifestEntry[] {
  const byKey = new Map<string, ResourceLike[]>();
  for (const resource of resources) {
    const key = resource.resourceKey.trim();
    if (!key) continue;
    const bucket = byKey.get(key) ?? [];
    bucket.push(resource);
    byKey.set(key, bucket);
  }

  const resolvedCurrent =
    currentResourceKey?.trim() ||
    pickResourceForTarget(
      resources.filter(resource => resource.isPrimary),
      executionTargetId
    )?.resourceKey ||
    pickResourceForTarget(resources, executionTargetId)?.resourceKey ||
    null;

  const primaryKey =
    pickResourceForTarget(
      resources.filter(resource => resource.isPrimary),
      executionTargetId
    )?.resourceKey ?? null;

  return [...byKey.entries()]
    .map(([resourceKey, bucket]) => {
      const row = pickResourceForTarget(bucket, executionTargetId);
      if (!row) return null;
      const hasTargetRow =
        executionTargetId !== null &&
        (row.executionTargetId === executionTargetId || row.executionTargetId === null);
      const observationState = row.id ? observationStatesByResourceId.get(row.id) : undefined;

      return {
        resourceKey,
        label: row.label,
        isPrimary: primaryKey !== null ? resourceKey === primaryKey : row.isPrimary,
        isCurrent: resourceKey === resolvedCurrent,
        path: executionTargetId && hasTargetRow ? row.path : null,
        state: observationState ?? (executionTargetId ? 'unknown' : 'unknown')
      };
    })
    .filter((entry): entry is ProjectResourceManifestEntry => entry !== null)
    .sort((left, right) => {
      if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
      return left.resourceKey.localeCompare(right.resourceKey);
    });
}

export async function buildProjectResourceManifest({
  ctx,
  projectId,
  executionTargetId = null,
  currentResourceKey = null
}: {
  ctx: ServiceContext;
  projectId: string;
  executionTargetId?: string | null;
  currentResourceKey?: string | null;
}): Promise<ProjectResourceManifestEntry[]> {
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const rows = (await ctx.db.all(
    `SELECT id, resource_key, label, path, is_primary, execution_target_id, status
       FROM project_resources
      WHERE project_id = ? AND deleted_at IS NULL
      ORDER BY is_primary DESC, created_at ASC`,
    [resolvedProjectId]
  )) as Array<{
    id: string;
    resource_key: string;
    label: string | null;
    path: string;
    is_primary: boolean | number;
    execution_target_id: string | null;
    status: string;
  }>;

  const resources: ResourceLike[] = rows.map(row => ({
    id: row.id,
    resourceKey: row.resource_key,
    label: row.label,
    path: row.path,
    isPrimary: isTruthyPrimary(row.is_primary),
    status: row.status,
    executionTargetId: row.execution_target_id
  }));

  const selected = [...new Map(resources.map(row => [row.resourceKey, row])).values()]
    .map(row => pickResourceForTarget(
      resources.filter(candidate => candidate.resourceKey === row.resourceKey),
      executionTargetId ?? null
    ))
    .filter((row): row is ResourceLike => row !== null);

  const observationStatesByResourceId = new Map<string, string>();
  if (executionTargetId && selected.length > 0) {
    const observations = await loadTargetResourceObservations({
      ctx,
      resourceIds: selected.map(row => row.id!).filter(Boolean)
    });
    for (const row of selected) {
      if (!row.id) continue;
      const observation = observations.get(row.id);
      if (observation && observation.executionTargetId === executionTargetId) {
        observationStatesByResourceId.set(row.id, observation.state);
      }
    }
  }

  const normalizedCurrent =
    currentResourceKey?.trim() ||
    (await findPrimaryProjectResource({
      ctx,
      projectId: resolvedProjectId,
      executionTargetId: executionTargetId ?? null
    }))?.resourceKey ||
    null;

  return buildProjectResourceManifestEntries({
    resources,
    executionTargetId: executionTargetId ?? null,
    currentResourceKey: normalizedCurrent,
    observationStatesByResourceId
  });
}

export function formatProjectResourcesInstructions(
  projectResources: ProjectResourceManifestEntry[]
): string | null {
  if (projectResources.length <= 1) return null;

  const current =
    projectResources.find(resource => resource.isCurrent) ?? projectResources[0] ?? null;
  if (!current) return null;

  const currentPath = current.path ?? '(not connected on this machine)';
  const lines = [
    '## Project Resources',
    `This project spans multiple repositories. You are working in \`${current.resourceKey}\` (${currentPath}).`,
    'Sibling resources on this machine (read for cross-repo context; do NOT report file changes outside your own working directory):'
  ];

  for (const resource of projectResources) {
    if (resource.isCurrent) continue;
    const pathPart = resource.path ?? '(not connected on this machine)';
    lines.push(`- \`${resource.resourceKey}\` — ${pathPart} (${resource.state})`);
  }

  return lines.join('\n');
}
