import type {
  CreateEverhourTimeBody,
  EverhourIntegrationDto,
  EverhourTimerDto,
  EverhourTimeRecordDto,
  MissionEverhourStateDto,
  ProjectDto,
  UpdateEverhourTimeBody
} from '../shared/contract.ts';

import { db, nowIso, recordChange, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';
import {
  getProject,
  PROJECT_EVERHOUR_PROJECT_ID_SETTINGS_KEY,
  PROJECT_EVERHOUR_PROJECT_NAME_SETTINGS_KEY,
  PROJECT_EVERHOUR_SECTION_ID_SETTINGS_KEY,
  readProjectEverhourProjectId,
  readProjectEverhourSectionId
} from './repository.ts';
import { readEverhourApiKey, writeEverhourApiKey } from './workspace-settings.ts';

const EVERHOUR_BASE_URL = 'https://api.everhour.com';

// ---- low-level fetch -----------------------------------------------------

/**
 * Call the Everhour REST API with the workspace API key. Everhour authenticates
 * with the `X-Api-Key` header and speaks JSON in both directions. Non-2xx
 * responses are surfaced as `ApiError` carrying the upstream status text so the
 * mission panel can show a useful message. A `204 No Content` resolves to `null`.
 */
async function everhourFetch<T>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${EVERHOUR_BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'X-Api-Key': apiKey,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    });
  } catch (err) {
    throw new ApiError(502, `Could not reach Everhour: ${(err as Error).message}`);
  }

  if (res.status === 204) return null as T;

  const text = await res.text();
  if (!res.ok) {
    // Everhour returns `{ "message": "..." }` on errors; fall back to raw text.
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      /* non-JSON error body */
    }
    const status = res.status === 401 ? 401 : res.status === 429 ? 429 : 502;
    throw new ApiError(status, `Everhour API error (${res.status}): ${detail || res.statusText}`);
  }

  if (!text) return null as T;
  return JSON.parse(text) as T;
}

function requireApiKey(): string {
  const apiKey = readEverhourApiKey({ workspaceId: WORKSPACE.id });
  if (!apiKey) {
    throw new ApiError(400, 'Connect Everhour in Settings → Integrations first.');
  }
  return apiKey;
}

// ---- Everhour response shapes (subset we consume) ------------------------

interface EverhourUser {
  id?: number;
  name?: string;
}

interface EverhourProject {
  id: string;
  name: string;
}

interface EverhourSection {
  id: number;
  name: string;
}

interface EverhourTask {
  id: string;
  name?: string;
}

interface EverhourTimeRecord {
  id?: number | string;
  time?: number;
  duration?: number;
  date?: string;
  comment?: string | null;
}

interface EverhourTimer {
  status?: string;
  duration?: number;
  startedAt?: string;
  comment?: string | null;
  task?: EverhourTask | null;
}

// ---- normalizers ---------------------------------------------------------

function normalizeRecord(raw: EverhourTimeRecord): EverhourTimeRecordDto {
  const seconds = typeof raw.time === 'number' ? raw.time : (raw.duration ?? 0);
  return {
    id: String(raw.id ?? ''),
    timeSeconds: seconds,
    date: raw.date ?? '',
    comment: raw.comment ?? null
  };
}

// Everhour list endpoints can return a bare array or a wrapped payload depending
// on the endpoint/version, so unwrap the common envelope keys before mapping.
function unwrapArray<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['records', 'data', 'time', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

// ---- integration (API key) -----------------------------------------------

export async function getEverhourIntegration(): Promise<EverhourIntegrationDto> {
  const apiKey = readEverhourApiKey({ workspaceId: WORKSPACE.id });
  if (!apiKey) return { connected: false, accountName: null };
  // Validate lazily: a stored-but-now-invalid key still reports connected so the
  // UI shows the disconnect affordance; the name is best-effort.
  try {
    const user = await everhourFetch<EverhourUser>(apiKey, '/users/me');
    return { connected: true, accountName: user?.name ?? null };
  } catch {
    return { connected: true, accountName: null };
  }
}

/** Validate + store a new workspace API key. Rejects keys Everhour won't accept. */
export async function setEverhourApiKey(rawKey: string): Promise<EverhourIntegrationDto> {
  const apiKey = rawKey.trim();
  if (!apiKey) throw new ApiError(400, 'Enter an Everhour API key.');
  // Validate before persisting so we never store a key that cannot authenticate.
  const user = await everhourFetch<EverhourUser>(apiKey, '/users/me');
  writeEverhourApiKey({ workspaceId: WORKSPACE.id, apiKey });
  return { connected: true, accountName: user?.name ?? null };
}

export function clearEverhourApiKey(): EverhourIntegrationDto {
  writeEverhourApiKey({ workspaceId: WORKSPACE.id, apiKey: null });
  return { connected: false, accountName: null };
}

// ---- project linking ------------------------------------------------------

function writeProjectEverhourSettings(
  projectId: string,
  updates: {
    everhourProjectId?: string | null;
    everhourProjectName?: string | null;
    everhourSectionId?: string | null;
  }
): void {
  const row = db
    .prepare(
      `SELECT settings_json, revision FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(projectId, WORKSPACE.id) as { settings_json: string; revision: number } | undefined;
  if (!row) throw new ApiError(404, 'Project not found');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.settings_json) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const apply = (key: string, value: string | null | undefined) => {
    if (value === undefined) return;
    if (value) parsed[key] = value;
    else delete parsed[key];
  };
  apply(PROJECT_EVERHOUR_PROJECT_ID_SETTINGS_KEY, updates.everhourProjectId);
  apply(PROJECT_EVERHOUR_PROJECT_NAME_SETTINGS_KEY, updates.everhourProjectName);
  apply(PROJECT_EVERHOUR_SECTION_ID_SETTINGS_KEY, updates.everhourSectionId);

  const revision = row.revision + 1;
  db.prepare(
    `UPDATE projects SET settings_json = @settings_json, updated_at = @now, revision = @revision
       WHERE id = @id AND workspace_id = @workspace_id`
  ).run({
    id: projectId,
    workspace_id: WORKSPACE.id,
    settings_json: JSON.stringify(parsed),
    now: nowIso(),
    revision
  });
  recordChange({
    entityType: 'project',
    entityId: projectId,
    operation: 'update',
    entityRevision: revision,
    projectId,
    changedFields: ['settings_json']
  });
}

// Find an existing Everhour project by exact (case-insensitive) name, else create
// a native board project. We also ensure a section exists so tasks can be created
// in it (board projects require a section on task creation).
async function resolveEverhourProject(
  apiKey: string,
  name: string
): Promise<{ id: string; sectionId: string | null }> {
  const query = encodeURIComponent(name);
  const found = await everhourFetch<EverhourProject[]>(
    apiKey,
    `/projects?query=${query}&limit=100`
  );
  const match = unwrapArray<EverhourProject>(found).find(
    p => p.name?.trim().toLowerCase() === name.trim().toLowerCase()
  );
  const project =
    match ??
    (await everhourFetch<EverhourProject>(apiKey, '/projects', {
      method: 'POST',
      body: { name, type: 'board' }
    }));

  return { id: project.id, sectionId: await resolveSectionId(apiKey, project.id) };
}

// Resolve a section to create tasks in (board projects require one). Reuses the
// first existing section, else creates an "Overlord" section. Some integration-
// backed projects don't support API-managed sections; there we return null and
// create tasks without a section.
async function resolveSectionId(apiKey: string, projectId: string): Promise<string | null> {
  try {
    const sections = unwrapArray<EverhourSection>(
      await everhourFetch<EverhourSection[]>(
        apiKey,
        `/projects/${encodeURIComponent(projectId)}/sections`
      )
    );
    if (sections.length > 0) return String(sections[0].id);
    const created = await everhourFetch<EverhourSection>(
      apiKey,
      `/projects/${encodeURIComponent(projectId)}/sections`,
      { method: 'POST', body: { name: 'Overlord', position: 1 } }
    );
    return created?.id !== undefined && created.id !== null ? String(created.id) : null;
  } catch {
    return null;
  }
}

/**
 * Link (or unlink) the Overlord project to an Everhour project by name. Passing an
 * empty/blank name clears the link. Returns the refreshed `ProjectDto`.
 */
export async function linkProjectEverhour(
  projectId: string,
  rawName: string | null
): Promise<ProjectDto> {
  const name = rawName?.trim() ?? '';
  if (!name) {
    writeProjectEverhourSettings(projectId, {
      everhourProjectId: null,
      everhourProjectName: null,
      everhourSectionId: null
    });
    return getProject(projectId);
  }

  const apiKey = requireApiKey();
  const resolved = await resolveEverhourProject(apiKey, name);
  writeProjectEverhourSettings(projectId, {
    everhourProjectId: resolved.id,
    everhourProjectName: name,
    everhourSectionId: resolved.sectionId
  });
  return getProject(projectId);
}

// ---- mission ↔ task linking ----------------------------------------------

interface MissionRow {
  id: string;
  project_id: string;
  title: string;
  everhour_task_id: string | null;
  revision: number;
}

function getMissionRow(missionId: string): MissionRow {
  const row = db
    .prepare(
      `SELECT id, project_id, title, everhour_task_id, revision
         FROM missions WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(missionId, WORKSPACE.id) as MissionRow | undefined;
  if (!row) throw new ApiError(404, 'Mission not found');
  return row;
}

function getProjectEverhour(projectId: string): {
  everhourProjectId: string | null;
  sectionId: string | null;
} {
  const row = db
    .prepare(`SELECT settings_json FROM projects WHERE id = ? AND workspace_id = ?`)
    .get(projectId, WORKSPACE.id) as { settings_json: string } | undefined;
  if (!row) return { everhourProjectId: null, sectionId: null };
  return {
    everhourProjectId: readProjectEverhourProjectId(row.settings_json),
    sectionId: readProjectEverhourSectionId(row.settings_json)
  };
}

function writeMissionTaskId(missionId: string, taskId: string, revision: number): void {
  const next = revision + 1;
  db.prepare(
    `UPDATE missions SET everhour_task_id = @task_id, updated_at = @now, revision = @revision
       WHERE id = @id AND workspace_id = @workspace_id`
  ).run({
    id: missionId,
    workspace_id: WORKSPACE.id,
    task_id: taskId,
    now: nowIso(),
    revision: next
  });
  recordChange({
    entityType: 'mission',
    entityId: missionId,
    operation: 'update',
    entityRevision: next,
    missionId,
    changedFields: ['everhour_task_id']
  });
}

/**
 * Ensure the mission is linked to an Everhour task, creating one in the project's
 * linked Everhour project on first use. Throws when the project isn't linked.
 */
async function ensureMissionTask(apiKey: string, missionId: string): Promise<string> {
  const mission = getMissionRow(missionId);
  if (mission.everhour_task_id) return mission.everhour_task_id;

  const { everhourProjectId, sectionId } = getProjectEverhour(mission.project_id);
  if (!everhourProjectId) {
    throw new ApiError(
      400,
      'Link this project to an Everhour project in project settings before tracking time.'
    );
  }

  const body: Record<string, unknown> = { name: mission.title || 'Untitled mission' };
  if (sectionId) body.section = Number(sectionId);
  const task = await everhourFetch<EverhourTask>(
    apiKey,
    `/projects/${encodeURIComponent(everhourProjectId)}/tasks`,
    { method: 'POST', body }
  );
  if (!task?.id) throw new ApiError(502, 'Everhour did not return a task id.');
  writeMissionTaskId(missionId, task.id, mission.revision);
  return task.id;
}

// ---- timer + time records -------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getCurrentTimer(apiKey: string): Promise<EverhourTimer | null> {
  const timer = await everhourFetch<EverhourTimer | null>(apiKey, '/timers/current');
  if (!timer || timer.status !== 'active') return null;
  return timer;
}

function toTimerDto(timer: EverhourTimer): EverhourTimerDto | null {
  const taskId = timer.task?.id;
  if (!taskId) return null;
  return {
    taskId,
    startedAt: timer.startedAt ?? null,
    durationSeconds: typeof timer.duration === 'number' ? timer.duration : 0,
    comment: timer.comment ?? null
  };
}

async function listTaskRecords(apiKey: string, taskId: string): Promise<EverhourTimeRecordDto[]> {
  // Everhour requires `from`/`to` when listing task time. Use a wide window
  // (roughly two years back through tomorrow) so all of a mission's records show.
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const from = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({ from, to, limit: '10000', page: '1' });
  const payload = await everhourFetch<unknown>(
    apiKey,
    `/tasks/${encodeURIComponent(taskId)}/time?${params.toString()}`
  );
  return unwrapArray<EverhourTimeRecord>(payload)
    .map(normalizeRecord)
    .filter(r => r.id)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Full Everhour state for one mission (connection, link, records, running timer). */
export async function getMissionEverhourState(missionId: string): Promise<MissionEverhourStateDto> {
  const apiKey = readEverhourApiKey({ workspaceId: WORKSPACE.id });
  const mission = getMissionRow(missionId);
  const { everhourProjectId } = getProjectEverhour(mission.project_id);
  const base: MissionEverhourStateDto = {
    connected: Boolean(apiKey),
    projectLinked: Boolean(everhourProjectId),
    taskId: mission.everhour_task_id,
    records: [],
    totalSeconds: 0,
    runningTimer: null
  };
  if (!apiKey || !mission.everhour_task_id) return base;

  const [records, timer] = await Promise.all([
    listTaskRecords(apiKey, mission.everhour_task_id),
    getCurrentTimer(apiKey)
  ]);
  const runningDto = timer ? toTimerDto(timer) : null;
  return {
    ...base,
    records,
    totalSeconds: records.reduce((sum, r) => sum + r.timeSeconds, 0),
    runningTimer: runningDto && runningDto.taskId === mission.everhour_task_id ? runningDto : null
  };
}

/** Start (or restart) the Everhour timer for this mission's task. */
export async function startMissionTimer(missionId: string): Promise<MissionEverhourStateDto> {
  const apiKey = requireApiKey();
  const taskId = await ensureMissionTask(apiKey, missionId);
  await everhourFetch(apiKey, '/timers', { method: 'POST', body: { task: taskId } });
  return getMissionEverhourState(missionId);
}

/** Stop the currently running Everhour timer (regardless of which task it's on). */
export async function stopMissionTimer(missionId: string): Promise<MissionEverhourStateDto> {
  const apiKey = requireApiKey();
  try {
    await everhourFetch(apiKey, '/timers/current', { method: 'DELETE' });
  } catch (err) {
    // A 404/no-active-timer is not an error from the user's point of view.
    if (!(err instanceof ApiError) || (err.status !== 404 && err.status !== 400)) throw err;
  }
  return getMissionEverhourState(missionId);
}

export async function addMissionTime(
  missionId: string,
  body: CreateEverhourTimeBody
): Promise<MissionEverhourStateDto> {
  const apiKey = requireApiKey();
  if (!Number.isFinite(body.timeSeconds) || body.timeSeconds <= 0) {
    throw new ApiError(400, 'Enter a positive duration.');
  }
  const taskId = await ensureMissionTask(apiKey, missionId);
  await everhourFetch(apiKey, '/time', {
    method: 'POST',
    body: {
      task: taskId,
      date: body.date?.trim() || todayIso(),
      time: Math.round(body.timeSeconds),
      ...(body.comment?.trim() ? { comment: body.comment.trim() } : {})
    }
  });
  return getMissionEverhourState(missionId);
}

export async function updateMissionTime(
  missionId: string,
  recordId: string,
  body: UpdateEverhourTimeBody
): Promise<MissionEverhourStateDto> {
  const apiKey = requireApiKey();
  if (!Number.isFinite(body.timeSeconds) || body.timeSeconds <= 0) {
    throw new ApiError(400, 'Enter a positive duration.');
  }
  await everhourFetch(apiKey, `/time/${encodeURIComponent(recordId)}`, {
    method: 'PUT',
    body: {
      time: Math.round(body.timeSeconds),
      ...(body.comment !== undefined ? { comment: body.comment?.trim() ?? '' } : {})
    }
  });
  return getMissionEverhourState(missionId);
}

export async function deleteMissionTime(
  missionId: string,
  recordId: string
): Promise<MissionEverhourStateDto> {
  const apiKey = requireApiKey();
  await everhourFetch(apiKey, `/time/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
  return getMissionEverhourState(missionId);
}
