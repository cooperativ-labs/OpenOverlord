import { generateDateFromSchedule, type ScheduleLike } from '@overlord/automations';
import type { DatabaseClient } from '@overlord/database';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { resolveMissionId } from './context.js';
import { ServiceError } from './errors.js';
import { newId, nowIso } from './util.js';

export type ScheduleWeekDay = {
  dayNum: number;
  times: string[];
};

export type ScheduleInput = {
  name?: string | null;
  periodType: string;
  periodInterval: number;
  weeksOfMonth?: number[];
  daysOfMonth?: number[];
  daysOfWeek?: ScheduleWeekDay[];
  timezone: string;
  startDate?: string | null;
  nextStatusId?: string | null;
};

export type ScheduleSummary = {
  id: string;
  workspaceId: string;
  name: string | null;
  periodType: string;
  periodInterval: number;
  weeksOfMonth: number[];
  daysOfMonth: number[];
  daysOfWeek: ScheduleWeekDay[];
  timezone: string;
  startDate: string | null;
  nextStatusId: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type MissionScheduleSummary = {
  dueDatetime: string | null;
  schedule: ScheduleSummary | null;
};

interface ScheduleRow {
  id: string;
  workspace_id: string;
  name: string | null;
  period_type: string;
  period_interval: number;
  weeks_of_month_json: string;
  days_of_month_json: string;
  days_of_week_json: string;
  timezone: string;
  start_date: string | null;
  next_status_id: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
}

function parseJsonArray(json: string): unknown[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toScheduleSummary(row: ScheduleRow): ScheduleSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    periodType: row.period_type,
    periodInterval: row.period_interval,
    weeksOfMonth: parseJsonArray(row.weeks_of_month_json) as number[],
    daysOfMonth: parseJsonArray(row.days_of_month_json) as number[],
    daysOfWeek: parseJsonArray(row.days_of_week_json) as ScheduleWeekDay[],
    timezone: row.timezone,
    startDate: row.start_date,
    nextStatusId: row.next_status_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision
  };
}

function toScheduleLike(input: ScheduleInput): ScheduleLike {
  return {
    name: input.name ?? undefined,
    periodType: input.periodType,
    periodInterval: input.periodInterval,
    weeksOfMonth: input.weeksOfMonth ?? undefined,
    daysOfMonth: input.daysOfMonth ?? undefined,
    daysOfWeek: input.daysOfWeek ?? undefined,
    timezone: input.timezone,
    startDate: input.startDate ?? undefined
  };
}

/**
 * Validates and computes the next due datetime without persisting anything.
 * Powers the ScheduleEditor live preview. Validation is delegated entirely to
 * the SchedulingEngine's zod schema (see automations/src/scheduling-engine);
 * this layer only translates the thrown validation `Error` into a `ServiceError`.
 */
export function previewScheduleDueDatetime(
  input: ScheduleInput,
  itemDueDatetime?: string | null
): string {
  try {
    const result = generateDateFromSchedule({
      schedule: toScheduleLike(input),
      itemDueDatetime: itemDueDatetime ? new Date(itemDueDatetime) : null
    });
    return result.toISOString();
  } catch (err) {
    throw new ServiceError(
      err instanceof Error ? err.message : 'Invalid schedule.',
      'validation_error',
      400
    );
  }
}

async function getScheduleRow(
  db: DatabaseClient,
  workspaceId: string,
  scheduleId: string
): Promise<ScheduleRow | undefined> {
  return db.get<ScheduleRow>(
    `SELECT id, workspace_id, name, period_type, period_interval, weeks_of_month_json,
            days_of_month_json, days_of_week_json, timezone, start_date, next_status_id,
            created_at, updated_at, revision
       FROM schedules WHERE id = ? AND workspace_id = ?`,
    [scheduleId, workspaceId]
  );
}

export async function getMissionSchedule({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<MissionScheduleSummary> {
  const resolved = await resolveMissionId(ctx, missionId);
  const mission = await ctx.db.get<{ schedule_id: string | null; due_datetime: string | null }>(
    `SELECT schedule_id, due_datetime FROM missions WHERE id = ? AND workspace_id = ?`,
    [resolved.id, ctx.workspace.id]
  );

  if (!mission) {
    throw new ServiceError('Mission not found', 'mission_not_found', 404);
  }

  if (!mission.schedule_id) {
    return { dueDatetime: mission.due_datetime, schedule: null };
  }

  const scheduleRow = await getScheduleRow(ctx.db, ctx.workspace.id, mission.schedule_id);

  return {
    dueDatetime: mission.due_datetime,
    schedule: scheduleRow ? toScheduleSummary(scheduleRow) : null
  };
}

export async function upsertMissionSchedule({
  ctx,
  missionId,
  input
}: {
  ctx: ServiceContext;
  missionId: string;
  input: ScheduleInput;
}): Promise<MissionScheduleSummary> {
  const resolved = await resolveMissionId(ctx, missionId);

  return ctx.db.transaction(async tx => {
    const mission = await tx.get<{
      id: string;
      schedule_id: string | null;
      due_datetime: string | null;
      revision: number;
    }>(
      `SELECT id, schedule_id, due_datetime, revision FROM missions WHERE id = ? AND workspace_id = ?`,
      [resolved.id, ctx.workspace.id]
    );

    if (!mission) {
      throw new ServiceError('Mission not found', 'mission_not_found', 404);
    }

    const dueDatetime = previewScheduleDueDatetime(input, mission.due_datetime);
    const now = nowIso();
    const scheduleId = mission.schedule_id ?? newId();

    if (mission.schedule_id) {
      await tx.run(
        `UPDATE schedules
           SET name = ?, period_type = ?, period_interval = ?, weeks_of_month_json = ?,
               days_of_month_json = ?, days_of_week_json = ?, timezone = ?, start_date = ?,
               next_status_id = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND workspace_id = ?`,
        [
          input.name?.trim() || null,
          input.periodType,
          input.periodInterval,
          JSON.stringify(input.weeksOfMonth ?? []),
          JSON.stringify(input.daysOfMonth ?? []),
          JSON.stringify(input.daysOfWeek ?? []),
          input.timezone,
          input.startDate ?? null,
          input.nextStatusId ?? null,
          now,
          mission.schedule_id,
          ctx.workspace.id
        ]
      );
    } else {
      await tx.run(
        `INSERT INTO schedules
           (id, workspace_id, name, period_type, period_interval, weeks_of_month_json,
            days_of_month_json, days_of_week_json, timezone, start_date, next_status_id,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          scheduleId,
          ctx.workspace.id,
          input.name?.trim() || null,
          input.periodType,
          input.periodInterval,
          JSON.stringify(input.weeksOfMonth ?? []),
          JSON.stringify(input.daysOfMonth ?? []),
          JSON.stringify(input.daysOfWeek ?? []),
          input.timezone,
          input.startDate ?? null,
          input.nextStatusId ?? null,
          now,
          now
        ]
      );
    }

    const revision = mission.revision + 1;
    await tx.run(
      `UPDATE missions SET schedule_id = ?, due_datetime = ?, updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
      [scheduleId, dueDatetime, now, revision, mission.id, ctx.workspace.id]
    );

    await recordChange({
      ctx: { ...ctx, db: tx },
      entityType: 'mission',
      entityId: mission.id,
      operation: 'update',
      entityRevision: revision,
      projectId: resolved.projectId,
      missionId: mission.id,
      changedFields: ['schedule_id', 'due_datetime']
    });

    const scheduleRow = await getScheduleRow(tx, ctx.workspace.id, scheduleId);
    if (!scheduleRow) {
      throw new ServiceError('Schedule not found after upsert', 'internal_error', 500);
    }

    return { dueDatetime, schedule: toScheduleSummary(scheduleRow) };
  });
}

export async function clearMissionSchedule({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<void> {
  const resolved = await resolveMissionId(ctx, missionId);

  await ctx.db.transaction(async tx => {
    const mission = await tx.get<{
      id: string;
      schedule_id: string | null;
      revision: number;
    }>(`SELECT id, schedule_id, revision FROM missions WHERE id = ? AND workspace_id = ?`, [
      resolved.id,
      ctx.workspace.id
    ]);

    if (!mission) {
      throw new ServiceError('Mission not found', 'mission_not_found', 404);
    }

    if (!mission.schedule_id) {
      return;
    }

    const now = nowIso();
    const revision = mission.revision + 1;
    await tx.run(
      `UPDATE missions SET schedule_id = NULL, due_datetime = NULL, updated_at = ?, revision = ?
         WHERE id = ? AND workspace_id = ?`,
      [now, revision, mission.id, ctx.workspace.id]
    );

    await recordChange({
      ctx: { ...ctx, db: tx },
      entityType: 'mission',
      entityId: mission.id,
      operation: 'update',
      entityRevision: revision,
      projectId: resolved.projectId,
      missionId: mission.id,
      changedFields: ['schedule_id', 'due_datetime']
    });

    const stillReferenced = await tx.get<{ id: string }>(
      `SELECT id FROM missions WHERE schedule_id = ? AND workspace_id = ? LIMIT 1`,
      [mission.schedule_id, ctx.workspace.id]
    );
    if (!stillReferenced) {
      await tx.run(`DELETE FROM schedules WHERE id = ? AND workspace_id = ?`, [
        mission.schedule_id,
        ctx.workspace.id
      ]);
    }
  });
}

/** Compute-only: the next due datetime for a mission's linked schedule, without persisting it. */
export async function getNextScheduledDueDatetime({
  ctx,
  missionId
}: {
  ctx: ServiceContext;
  missionId: string;
}): Promise<string> {
  const resolved = await resolveMissionId(ctx, missionId);
  const mission = await ctx.db.get<{ schedule_id: string | null; due_datetime: string | null }>(
    `SELECT schedule_id, due_datetime FROM missions WHERE id = ? AND workspace_id = ?`,
    [resolved.id, ctx.workspace.id]
  );

  if (!mission?.schedule_id) {
    throw new ServiceError('Mission has no schedule', 'validation_error', 409);
  }

  const scheduleRow = await getScheduleRow(ctx.db, ctx.workspace.id, mission.schedule_id);
  if (!scheduleRow) {
    throw new ServiceError('Schedule not found', 'not_found', 404);
  }

  return previewScheduleDueDatetime(toScheduleInputFromRow(scheduleRow), mission.due_datetime);
}

function toScheduleInputFromRow(row: ScheduleRow): ScheduleInput {
  const summary = toScheduleSummary(row);
  return {
    name: summary.name,
    periodType: summary.periodType,
    periodInterval: summary.periodInterval,
    weeksOfMonth: summary.weeksOfMonth,
    daysOfMonth: summary.daysOfMonth,
    daysOfWeek: summary.daysOfWeek,
    timezone: summary.timezone,
    startDate: summary.startDate,
    nextStatusId: summary.nextStatusId
  };
}
