import {
  deriveTitleFromInstructionText,
  generateAndSetObjectiveTitle,
  generateObjectiveTitle
} from '@overlord/automations';

import { db, nowIso, recordChange } from './db.ts';
import { realtime } from './realtime.ts';

type ObjectiveContext = {
  objectiveId: string;
  projectId: string;
  ticketId: string;
};

type TicketContext = {
  ticketId: string;
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
    const existing = db
      .prepare(
        `SELECT id, project_id, ticket_id, title, revision
           FROM objectives
          WHERE id = ? AND deleted_at IS NULL`
      )
      .get(objectiveId) as
      | {
          id: string;
          project_id: string;
          ticket_id: string;
          title: string | null;
          revision: number;
        }
      | undefined;

    if (!existing || existing.title === title) {
      return;
    }

    const now = nowIso();
    const revision = existing.revision + 1;
    db.prepare(
      `UPDATE objectives SET title = @title, updated_at = @now, revision = @revision WHERE id = @id`
    ).run({ id: objectiveId, title, now, revision });

    recordChange({
      entityType: 'objective',
      entityId: objectiveId,
      operation: 'update',
      entityRevision: revision,
      projectId: existing.project_id,
      ticketId: existing.ticket_id,
      objectiveId,
      changedFields: ['title']
    });
  }
};

async function updateTicketTitle({
  ticketId,
  title
}: {
  ticketId: string;
  title: string;
}): Promise<void> {
  const existing = db
    .prepare(
      `SELECT id, project_id, title, revision
         FROM tickets
        WHERE id = ? AND deleted_at IS NULL`
    )
    .get(ticketId) as
    | { id: string; project_id: string; title: string; revision: number }
    | undefined;

  if (!existing || existing.title === title) {
    return;
  }

  const now = nowIso();
  const revision = existing.revision + 1;
  db.prepare(
    `UPDATE tickets SET title = @title, updated_at = @now, revision = @revision WHERE id = @id`
  ).run({ id: ticketId, title, now, revision });

  recordChange({
    entityType: 'ticket',
    entityId: ticketId,
    operation: 'update',
    entityRevision: revision,
    projectId: existing.project_id,
    ticketId,
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

export function scheduleTicketTitleGeneration(
  params: TicketContext & { instructionText: string }
): void {
  notifyAfterTitleAutomation(
    generateObjectiveTitle({
      instructionText: params.instructionText,
      env: process.env
    }).then((title: string) => {
      if (!title) {
        return;
      }
      return updateTicketTitle({ ticketId: params.ticketId, title });
    })
  );
}

/**
 * Synchronous counterpart to {@link scheduleTicketTitleGeneration} for the
 * manual "Generate title" button: awaits the summarizer and persists the
 * result before responding, so the caller can show the title (or a failure)
 * immediately instead of waiting on a realtime echo.
 */
export async function generateTicketTitleNow(
  params: TicketContext & { instructionText: string }
): Promise<string> {
  const title = await generateObjectiveTitle({
    instructionText: params.instructionText,
    env: process.env
  });
  if (!title) {
    return '';
  }
  await updateTicketTitle({ ticketId: params.ticketId, title });
  return title;
}
