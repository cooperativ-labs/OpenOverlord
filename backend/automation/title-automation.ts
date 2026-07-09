import {
  deriveTitleFromInstructionText,
  generateAndSetObjectiveTitle,
  generateObjectiveTitle
} from '@overlord/automations';

import { nowIso, recordChange, requireDatabaseClient } from '../db.ts';
import { realtime } from '../realtime.ts';

type ObjectiveContext = {
  objectiveId: string;
  projectId: string;
  missionId: string;
};

type MissionContext = {
  missionId: string;
  projectId: string;
};

const objectiveTitleStore = {
  updateObjectiveTitle: async ({
    objectiveId,
    title
  }: {
    objectiveId: string;
    title: string;
  }): Promise<void> => {
    const existing = await requireDatabaseClient().get<{
      id: string;
      project_id: string;
      mission_id: string;
      title: string | null;
      revision: number;
    }>(
      `SELECT id, project_id, mission_id, title, revision
         FROM objectives
        WHERE id = ? AND deleted_at IS NULL`,
      [objectiveId]
    );

    if (!existing || existing.title === title) {
      return;
    }

    const now = nowIso();
    const revision = existing.revision + 1;
    await requireDatabaseClient().run(
      `UPDATE objectives SET title = ?, updated_at = ?, revision = ? WHERE id = ?`,
      [title, now, revision, objectiveId]
    );

    await recordChange({
      entityType: 'objective',
      entityId: objectiveId,
      operation: 'update',
      entityRevision: revision,
      projectId: existing.project_id,
      missionId: existing.mission_id,
      objectiveId,
      changedFields: ['title']
    });
  }
};

async function updateMissionTitle({
  missionId,
  title
}: {
  missionId: string;
  title: string;
}): Promise<void> {
  const existing = await requireDatabaseClient().get<{
    id: string;
    project_id: string;
    title: string;
    revision: number;
  }>(
    `SELECT id, project_id, title, revision
       FROM missions
      WHERE id = ? AND deleted_at IS NULL`,
    [missionId]
  );

  if (!existing || existing.title === title) {
    return;
  }

  const now = nowIso();
  const revision = existing.revision + 1;
  await requireDatabaseClient().run(
    `UPDATE missions SET title = ?, updated_at = ?, revision = ? WHERE id = ?`,
    [title, now, revision, missionId]
  );

  await recordChange({
    entityType: 'mission',
    entityId: missionId,
    operation: 'update',
    entityRevision: revision,
    projectId: existing.project_id,
    missionId,
    changedFields: ['title']
  });
}

function notifyAfterTitleAutomation(task: Promise<void>): void {
  void task
    .then(() => {
      realtime.pollNow();
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[webapp] title automation failed:', message);
    });
}

/** Immediate local title for create flows; Gemini may refine it asynchronously. */
export function initialTitleFromInstruction(instructionText: string): string {
  return deriveTitleFromInstructionText(instructionText.trim());
}

export function scheduleObjectiveTitleGeneration(
  params: ObjectiveContext & { instructionText: string }
): void {
  notifyAfterTitleAutomation(
    generateAndSetObjectiveTitle({
      store: objectiveTitleStore,
      objectiveId: params.objectiveId,
      instructionText: params.instructionText,
      env: process.env
    })
  );
}

export function scheduleMissionTitleGeneration(
  params: MissionContext & { instructionText: string }
): void {
  notifyAfterTitleAutomation(
    generateObjectiveTitle({
      instructionText: params.instructionText,
      env: process.env
    }).then((title: string) => {
      if (!title) {
        return;
      }
      return updateMissionTitle({ missionId: params.missionId, title });
    })
  );
}

/**
 * Synchronous counterpart to {@link scheduleMissionTitleGeneration} for the
 * manual "Generate title" button: awaits the summarizer and persists the
 * result before responding, so the caller can show the title (or a failure)
 * immediately instead of waiting on a realtime echo.
 */
export async function generateMissionTitleNow(
  params: MissionContext & { instructionText: string }
): Promise<string> {
  const title = await generateObjectiveTitle({
    instructionText: params.instructionText,
    env: process.env
  });
  if (!title) {
    return '';
  }
  await updateMissionTitle({ missionId: params.missionId, title });
  return title;
}
