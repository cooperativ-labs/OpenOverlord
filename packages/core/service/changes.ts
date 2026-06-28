import path from 'node:path';

import { readGitStatusPorcelain } from './local-target/git-status.ts';
import { isCoLocatedBackend } from './local-target/index.ts';
import type { ServiceContext } from './context.js';
import { resolveMissionId } from './context.js';
import { discoverProject } from './projects.js';

export type ChangedFileReview = {
  filePath: string;
  vcsStatus: string | null;
  currentDiffState: string | null;
  objectiveId: string | null;
  sessionId: string | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  rationaleCount: number;
  finalRationaleCount: number;
  rationaleLabels: string[];
  coverage: 'covered' | 'missing_rationale' | 'skipped' | 'unassigned';
};

export type RationaleReview = {
  id: string;
  filePath: string;
  label: string;
  summary: string;
  why: string;
  impact: string;
  objectiveId: string;
  sessionId: string | null;
  deliveryId: string | null;
  isFinal: boolean;
  createdAt: string;
};

function parseObservedMetadata(raw: string | null | undefined): {
  rationaleSkipped?: boolean;
} {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as { rationaleSkipped?: boolean };
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function resolveWorkingDirectory({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<string | null> {
  try {
    const mission = await resolveMissionId(ctx, missionId);
    const discovery = await discoverProject({ ctx, projectId: mission.projectId });
    return discovery.resourcePath ? path.resolve(discovery.resourcePath) : null;
  } catch {
    return null;
  }
}

export async function listChangedFilesForReview({
  ctx,
  missionId,
  objectiveId,
  includeCurrent = true
}: {
  ctx: ServiceContext;
  missionId: string;
  objectiveId?: string | null;
  includeCurrent?: boolean;
}): Promise<ChangedFileReview[]> {
  const mission = await resolveMissionId(ctx, missionId);
  const params: string[] = [mission.id];
  const objectiveFilter = objectiveId ? 'AND cf.objective_id = ?' : '';
  if (objectiveId) params.push(objectiveId);

  const rows = (await ctx.db.all(
    `SELECT cf.file_path, cf.vcs_status, cf.current_diff_state, cf.objective_id, cf.session_id,
              cf.first_observed_at, cf.last_observed_at, cf.observed_metadata_json,
              COUNT(cr.id) AS rationale_count,
              SUM(CASE WHEN cr.is_final THEN 1 ELSE 0 END) AS final_rationale_count,
              GROUP_CONCAT(cr.label, char(10)) AS rationale_labels
       FROM changed_files cf
       LEFT JOIN change_rationales cr
         ON cr.mission_id = cf.mission_id
        AND cr.objective_id = cf.objective_id
        AND cr.file_path = cf.file_path
        AND cr.deleted_at IS NULL
       WHERE cf.mission_id = ? AND cf.deleted_at IS NULL ${objectiveFilter}
       GROUP BY cf.id
       ORDER BY cf.file_path ASC`,
    params
  )) as Array<{
    file_path: string;
    vcs_status: string | null;
    current_diff_state: string | null;
    objective_id: string | null;
    session_id: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    observed_metadata_json: string | null;
    rationale_count: number;
    final_rationale_count: number | null;
    rationale_labels: string | null;
  }>;

  const byPath = new Map<string, ChangedFileReview>();
  for (const row of rows) {
    const rationaleCount = Number(row.rationale_count ?? 0);
    const finalRationaleCount = Number(row.final_rationale_count ?? 0);
    const metadata = parseObservedMetadata(row.observed_metadata_json);
    const coverage =
      metadata.rationaleSkipped === true
        ? 'skipped'
        : finalRationaleCount > 0 || rationaleCount > 0
          ? 'covered'
          : 'missing_rationale';
    byPath.set(row.file_path, {
      filePath: row.file_path,
      vcsStatus: row.vcs_status,
      currentDiffState: row.current_diff_state,
      objectiveId: row.objective_id,
      sessionId: row.session_id,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
      rationaleCount,
      finalRationaleCount,
      rationaleLabels: row.rationale_labels?.split('\n').filter(Boolean) ?? [],
      coverage
    });
  }

  // Co-located (Local SQLite) backend only: the porcelain status is read
  // directly here because no provider capability lists current changes yet —
  // `readCurrentDiff` is still `CAPABILITY_NOT_IMPLEMENTED`. Routing this read
  // through the seam waits on that capability landing across all transports.
  if (includeCurrent && isCoLocatedBackend(ctx.db)) {
    const workingDirectory = await resolveWorkingDirectory({ ctx, missionId: mission.id });
    if (workingDirectory) {
      for (const current of readGitStatusPorcelain(workingDirectory)) {
        if (byPath.has(current.filePath)) continue;
        byPath.set(current.filePath, {
          filePath: current.filePath,
          vcsStatus: current.vcsStatus,
          currentDiffState: 'present',
          objectiveId: null,
          sessionId: null,
          firstObservedAt: null,
          lastObservedAt: null,
          rationaleCount: 0,
          finalRationaleCount: 0,
          rationaleLabels: [],
          coverage: 'unassigned'
        });
      }
    }
  }

  return Array.from(byPath.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export async function listRationalesForReview({
  ctx,
  missionId,
  objectiveId
}: {
  ctx: ServiceContext;
  missionId: string;
  objectiveId?: string | null;
}): Promise<RationaleReview[]> {
  const mission = await resolveMissionId(ctx, missionId);
  const params: string[] = [mission.id];
  const objectiveFilter = objectiveId ? 'AND objective_id = ?' : '';
  if (objectiveId) params.push(objectiveId);

  const rows = (await ctx.db.all(
    `SELECT id, file_path, label, summary, why, impact, objective_id, session_id,
              delivery_id, is_final, created_at
       FROM change_rationales
       WHERE mission_id = ? AND deleted_at IS NULL ${objectiveFilter}
       ORDER BY file_path ASC, created_at ASC`,
    params
  )) as Array<{
    id: string;
    file_path: string;
    label: string;
    summary: string;
    why: string;
    impact: string;
    objective_id: string;
    session_id: string | null;
    delivery_id: string | null;
    is_final: boolean | number;
    created_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    filePath: row.file_path,
    label: row.label,
    summary: row.summary,
    why: row.why,
    impact: row.impact,
    objectiveId: row.objective_id,
    sessionId: row.session_id,
    deliveryId: row.delivery_id,
    isFinal: Boolean(row.is_final),
    createdAt: row.created_at
  }));
}
