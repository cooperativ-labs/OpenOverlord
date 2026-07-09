import type { DatabaseClient } from '@overlord/database';

import { newId, nowIso } from '../db.ts';

/**
 * Insert the single `mission_events` row both runner-side branch recorders emit
 * — `recordBranchPreparedTx` (branch prepared for an execution request) and
 * `recordBranchActionActivityFromMutation` (an on-demand merge/push/publish
 * mutation completing). One writer keeps the column list, event `type`/`phase`,
 * `source`, and null-actor attribution identical between the two paths, and —
 * critically — pins the event to the mission's *own* `workspaceId` rather than
 * whichever workspace the caller currently has active (coo:135).
 */
export async function recordRunnerBranchEvent(
  tx: DatabaseClient,
  {
    workspaceId,
    projectId,
    missionId,
    objectiveId = null,
    summary,
    payload,
    now = nowIso()
  }: {
    workspaceId: string;
    projectId: string;
    missionId: string;
    objectiveId?: string | null;
    summary: string;
    payload: Record<string, unknown>;
    now?: string;
  }
): Promise<void> {
  await tx.run(
    `INSERT INTO mission_events
       (id, workspace_id, project_id, mission_id, objective_id, type, phase, summary,
        payload_json, source, actor_workspace_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'update', 'execute', ?, ?, 'runner', NULL, ?)`,
    [newId(), workspaceId, projectId, missionId, objectiveId, summary, JSON.stringify(payload), now]
  );
}
