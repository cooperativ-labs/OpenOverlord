import type { ServiceContext } from './context.js';
import { resolveProjectId } from './context.js';
import { loadTargetResourceObservations } from './target-resource-observations.js';

export type ProjectResourceAccessMode = 'read' | 'read_write';

export type ProjectResourceManifestEntry = {
  resourceKey: string;
  label: string | null;
  isPrimary: boolean;
  isCurrent: boolean;
  /** Read vs read & write permission (coo:368). Primary resources are `read_write`. */
  accessMode: ProjectResourceAccessMode;
  path: string | null;
  state: string;
};

type ResourceLike = {
  id?: string;
  resourceKey: string;
  label: string | null;
  path: string;
  isPrimary: boolean;
  accessMode: ProjectResourceAccessMode;
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

  const primaryKey =
    pickResourceForTarget(
      resources.filter(resource => resource.isPrimary),
      executionTargetId
    )?.resourceKey ?? null;

  const resolvedCurrent =
    currentResourceKey?.trim() ||
    primaryKey ||
    pickResourceForTarget(resources, executionTargetId)?.resourceKey ||
    null;

  return [...byKey.entries()]
    .map(([resourceKey, bucket]) => {
      const row = pickResourceForTarget(bucket, executionTargetId);
      if (!row) return null;
      const hasTargetRow =
        executionTargetId !== null &&
        (row.executionTargetId === executionTargetId || row.executionTargetId === null);
      const observationState = row.id ? observationStatesByResourceId.get(row.id) : undefined;

      const isPrimary = primaryKey !== null ? resourceKey === primaryKey : row.isPrimary;
      return {
        resourceKey,
        label: row.label,
        isPrimary,
        isCurrent: resourceKey === resolvedCurrent,
        // Primary resources are always read & write (coo:368).
        accessMode: isPrimary ? 'read_write' : row.accessMode,
        path: executionTargetId && hasTargetRow ? row.path : null,
        state: observationState ?? 'unknown'
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
    `SELECT pr.id, pr.resource_key, pr.label, prs.source_kind, prs.descriptor_json,
            pr.is_primary, pr.access_mode, prs.execution_target_id
       FROM project_resources pr
       LEFT JOIN project_resource_sources prs ON prs.resource_id = pr.id AND prs.deleted_at IS NULL
      WHERE pr.project_id = ? AND pr.deleted_at IS NULL
      ORDER BY pr.is_primary DESC, pr.created_at ASC`,
    [resolvedProjectId]
  )) as Array<{
    id: string;
    resource_key: string;
    label: string | null;
    source_kind: string | null;
    descriptor_json: string | null;
    is_primary: boolean | number;
    access_mode: string | null;
    execution_target_id: string | null;
  }>;

  const resources: ResourceLike[] = rows.map(row => ({
    id: row.id,
    resourceKey: row.resource_key,
    label: row.label,
    path: (() => {
      if (row.source_kind !== 'local_checkout' || !row.descriptor_json) return '';
      try {
        const value = (JSON.parse(row.descriptor_json) as { path?: unknown }).path;
        return typeof value === 'string' ? value : '';
      } catch {
        return '';
      }
    })(),
    isPrimary: isTruthyPrimary(row.is_primary),
    accessMode: row.access_mode === 'read' ? 'read' : 'read_write',
    executionTargetId: row.execution_target_id
  }));

  const observationStatesByResourceId = new Map<string, string>();
  if (executionTargetId && resources.length > 0) {
    // Observe only the row each key resolves to for this target — the same row
    // buildProjectResourceManifestEntries will surface.
    const pickedIds = [...new Set(resources.map(row => row.resourceKey))]
      .map(
        key =>
          pickResourceForTarget(
            resources.filter(row => row.resourceKey === key),
            executionTargetId
          )?.id
      )
      .filter((id): id is string => Boolean(id));
    const observations = await loadTargetResourceObservations({ ctx, resourceIds: pickedIds });
    for (const [resourceId, observation] of observations) {
      if (observation.executionTargetId === executionTargetId) {
        observationStatesByResourceId.set(resourceId, observation.state);
      }
    }
  }

  return buildProjectResourceManifestEntries({
    resources,
    executionTargetId: executionTargetId ?? null,
    // Entries fall back to the target-scoped primary key when no explicit
    // current key is provided, so no separate primary lookup is needed here.
    currentResourceKey: currentResourceKey?.trim() || null,
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
