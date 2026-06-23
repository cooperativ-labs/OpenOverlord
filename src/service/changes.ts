import { execFileSync } from 'node:child_process';
import path from 'node:path';

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
  coverage: 'covered' | 'missing_rationale' | 'unassigned';
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

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function currentGitStatus(
  workingDirectory: string
): Array<{ filePath: string; vcsStatus: string }> {
  try {
    const output = execFileSync('git', ['status', '--short'], {
      cwd: workingDirectory,
      encoding: 'utf8'
    });
    return output
      .split('\n')
      .map(line => line.trimEnd())
      .filter(Boolean)
      .map(line => ({
        vcsStatus: line.slice(0, 2).trim() || 'changed',
        filePath: normalizePath(line.slice(3).trim())
      }))
      .filter(entry => entry.filePath.length > 0);
  } catch {
    return [];
  }
}

function resolveWorkingDirectory({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): string | null {
  try {
    const mission = resolveMissionId(ctx, missionId);
    const discovery = discoverProject({ ctx, projectId: mission.projectId });
    return discovery.resourcePath ? path.resolve(discovery.resourcePath) : null;
  } catch {
    return null;
  }
}

export function listChangedFilesForReview({
  ctx,
  missionId,
  objectiveId,
  includeCurrent = true
}: {
  ctx: ServiceContext;
  missionId: string;
  objectiveId?: string | null;
  includeCurrent?: boolean;
}): ChangedFileReview[] {
  const mission = resolveMissionId(ctx, missionId);
  const params: string[] = [mission.id];
  const objectiveFilter = objectiveId ? 'AND cf.objective_id = ?' : '';
  if (objectiveId) params.push(objectiveId);

  const rows = ctx.db
    .prepare(
      `SELECT cf.file_path, cf.vcs_status, cf.current_diff_state, cf.objective_id, cf.session_id,
              cf.first_observed_at, cf.last_observed_at,
              COUNT(cr.id) AS rationale_count,
              SUM(CASE WHEN cr.is_final = 1 THEN 1 ELSE 0 END) AS final_rationale_count,
              GROUP_CONCAT(cr.label, char(10)) AS rationale_labels
       FROM changed_files cf
       LEFT JOIN change_rationales cr
         ON cr.mission_id = cf.mission_id
        AND cr.objective_id = cf.objective_id
        AND cr.file_path = cf.file_path
        AND cr.deleted_at IS NULL
       WHERE cf.mission_id = ? AND cf.deleted_at IS NULL ${objectiveFilter}
       GROUP BY cf.id
       ORDER BY cf.file_path ASC`
    )
    .all(...params) as Array<{
    file_path: string;
    vcs_status: string | null;
    current_diff_state: string | null;
    objective_id: string | null;
    session_id: string | null;
    first_observed_at: string | null;
    last_observed_at: string | null;
    rationale_count: number;
    final_rationale_count: number | null;
    rationale_labels: string | null;
  }>;

  const byPath = new Map<string, ChangedFileReview>();
  for (const row of rows) {
    const rationaleCount = Number(row.rationale_count ?? 0);
    const finalRationaleCount = Number(row.final_rationale_count ?? 0);
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
      coverage: finalRationaleCount > 0 || rationaleCount > 0 ? 'covered' : 'missing_rationale'
    });
  }

  if (includeCurrent) {
    const workingDirectory = resolveWorkingDirectory({ ctx, missionId: mission.id });
    if (workingDirectory) {
      for (const current of currentGitStatus(workingDirectory)) {
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

export function listRationalesForReview({
  ctx,
  missionId,
  objectiveId
}: {
  ctx: ServiceContext;
  missionId: string;
  objectiveId?: string | null;
}): RationaleReview[] {
  const mission = resolveMissionId(ctx, missionId);
  const params: string[] = [mission.id];
  const objectiveFilter = objectiveId ? 'AND objective_id = ?' : '';
  if (objectiveId) params.push(objectiveId);

  const rows = ctx.db
    .prepare(
      `SELECT id, file_path, label, summary, why, impact, objective_id, session_id,
              delivery_id, is_final, created_at
       FROM change_rationales
       WHERE mission_id = ? AND deleted_at IS NULL ${objectiveFilter}
       ORDER BY file_path ASC, created_at ASC`
    )
    .all(...params) as Array<{
    id: string;
    file_path: string;
    label: string;
    summary: string;
    why: string;
    impact: string;
    objective_id: string;
    session_id: string | null;
    delivery_id: string | null;
    is_final: number;
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
    isFinal: row.is_final === 1,
    createdAt: row.created_at
  }));
}

export function readCurrentDiff({
  ctx,
  missionId,
  filePath
}: {
  ctx: ServiceContext;
  missionId: string;
  filePath?: string | null;
}): { workingDirectory: string | null; diff: string; unavailable: boolean } {
  const workingDirectory = resolveWorkingDirectory({ ctx, missionId });
  if (!workingDirectory) {
    return { workingDirectory: null, diff: '', unavailable: true };
  }

  try {
    const args = ['diff', '--'];
    if (filePath) args.push(filePath);
    const diff = execFileSync('git', args, { cwd: workingDirectory, encoding: 'utf8' });
    return { workingDirectory, diff, unavailable: false };
  } catch {
    return { workingDirectory, diff: '', unavailable: true };
  }
}
