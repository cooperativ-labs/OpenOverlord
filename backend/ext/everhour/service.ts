import type {
  CreateEverhourTimeBody,
  EverhourIntegrationDto,
  EverhourTimerDto,
  EverhourTimeRecordDto,
  MissionEverhourStateDto,
  ProjectEverhourLinkDto,
  UpdateEverhourTimeBody
} from '@overlord/contract/ext/everhour';
import type { DatabaseClient } from '@overlord/database';

import { newId, nowIso, recordChange, requireDatabaseClient, WORKSPACE } from '../../db.ts';
import { ApiError } from '../../errors.ts';

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
    // Forward genuine client errors (auth, permission, not-found, rate limit)
    // with their real status so the UI shows an actionable message instead of a
    // generic "Bad Gateway". Only true upstream/server failures (5xx or unknown)
    // become a 502.
    const status = res.status >= 400 && res.status < 500 ? res.status : 502;
    throw new ApiError(status, `Everhour API error (${res.status}): ${detail || res.statusText}`);
  }

  if (!text) return null as T;
  return JSON.parse(text) as T;
}

// The id of the user the API key authenticates as. Everhour denies creating
// sections/tasks in a project this user is not a member of, so we must add them
// to any project we link for time tracking.
async function getCurrentEverhourUserId(apiKey: string): Promise<number | null> {
  const user = await everhourFetch<EverhourUser>(apiKey, '/users/me');
  return typeof user?.id === 'number' ? user.id : null;
}

// Native Everhour projects/tasks use the `ev:` id prefix. Every other prefix
// (`gh:` GitHub, `jr:` Jira, `as:` Asana, `tr:` Trello, …) denotes an
// integration-synced project whose tasks mirror the external source and which
// rejects API task creation with a 403 "Access denied". The timer feature
// requires creating a task, so those projects cannot back time tracking.
function isNativeEverhourProjectId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('ev:');
}

async function requireApiKey(): Promise<string> {
  const apiKey = await readEverhourApiKey();
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
  type?: string;
  users?: number[];
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

interface WorkspaceConnectionRow {
  id: string;
  api_key_secret: string;
  account_id: string | null;
  account_name: string | null;
  revision: number;
}

interface ProjectLinkRow {
  id: string;
  project_id: string;
  everhour_project_id: string;
  everhour_project_name: string;
  everhour_section_id: string | null;
  revision: number;
}

interface MissionLinkRow {
  id: string;
  mission_id: string;
  everhour_task_id: string;
  revision: number;
}

async function readEverhourConnection(
  client: DatabaseClient = requireDatabaseClient()
): Promise<WorkspaceConnectionRow | null> {
  const row = await client.get<WorkspaceConnectionRow>(
    `SELECT id, api_key_secret, account_id, account_name, revision
       FROM ext_everhour_workspace_connections
      WHERE workspace_id = ? AND deleted_at IS NULL`,
    [WORKSPACE.id]
  );
  return row ?? null;
}

async function readEverhourApiKey(
  client: DatabaseClient = requireDatabaseClient()
): Promise<string | null> {
  return (await readEverhourConnection(client))?.api_key_secret ?? null;
}

async function writeEverhourConnection(
  apiKey: string,
  accountName: string | null,
  accountId: string | null
): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await readEverhourConnection(tx);
    const now = nowIso();
    if (existing) {
      const revision = existing.revision + 1;
      await tx.run(
        `UPDATE ext_everhour_workspace_connections
            SET api_key_secret = ?, account_id = ?, account_name = ?,
                updated_at = ?, revision = ?
          WHERE id = ? AND workspace_id = ? AND revision = ?`,
        [apiKey, accountId, accountName, now, revision, existing.id, WORKSPACE.id, existing.revision]
      );
      await recordChange(
        {
          entityType: 'everhour:workspace_connection',
          entityId: existing.id,
          operation: 'update',
          entityRevision: revision,
          changedFields: ['accountId', 'accountName']
        },
        tx
      );
      return;
    }

    const id = newId();
    await tx.run(
      `INSERT INTO ext_everhour_workspace_connections
         (id, workspace_id, api_key_secret, account_id, account_name, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, WORKSPACE.id, apiKey, accountId, accountName, now, now]
    );
    await recordChange(
      {
        entityType: 'everhour:workspace_connection',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        changedFields: ['connected', 'accountId', 'accountName']
      },
      tx
    );
  });
}

async function clearEverhourConnection(): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await readEverhourConnection(tx);
    if (!existing) return;
    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE ext_everhour_workspace_connections
          SET deleted_at = ?, updated_at = ?, revision = ?
        WHERE id = ? AND workspace_id = ? AND revision = ?`,
      [now, now, revision, existing.id, WORKSPACE.id, existing.revision]
    );
    await recordChange(
      {
        entityType: 'everhour:workspace_connection',
        entityId: existing.id,
        operation: 'delete',
        entityRevision: revision,
        changedFields: ['connected']
      },
      tx
    );
  });
}

export async function getEverhourIntegration(): Promise<EverhourIntegrationDto> {
  const connection = await readEverhourConnection();
  if (!connection) return { connected: false, accountName: null };
  // Validate lazily: a stored-but-now-invalid key still reports connected so the
  // UI shows the disconnect affordance; the name is best-effort.
  try {
    const user = await everhourFetch<EverhourUser>(connection.api_key_secret, '/users/me');
    return { connected: true, accountName: user?.name ?? connection.account_name };
  } catch {
    return { connected: true, accountName: connection.account_name };
  }
}

/** Validate + store a new workspace API key. Rejects keys Everhour won't accept. */
export async function setEverhourApiKey(rawKey: string): Promise<EverhourIntegrationDto> {
  const apiKey = rawKey.trim();
  if (!apiKey) throw new ApiError(400, 'Enter an Everhour API key.');
  // Validate before persisting so we never store a key that cannot authenticate.
  const user = await everhourFetch<EverhourUser>(apiKey, '/users/me');
  await writeEverhourConnection(
    apiKey,
    user?.name ?? null,
    user?.id !== undefined && user.id !== null ? String(user.id) : null
  );
  return { connected: true, accountName: user?.name ?? null };
}

export async function clearEverhourApiKey(): Promise<EverhourIntegrationDto> {
  await clearEverhourConnection();
  return { connected: false, accountName: null };
}

// ---- project linking ------------------------------------------------------

async function readProjectLink(
  projectId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<ProjectLinkRow | null> {
  const row = await client.get<ProjectLinkRow>(
    `SELECT id, project_id, everhour_project_id, everhour_project_name,
            everhour_section_id, revision
       FROM ext_everhour_project_links
      WHERE project_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, WORKSPACE.id]
  );
  return row ?? null;
}

async function assertProjectExists(
  projectId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<void> {
  const row = await client.get(
    `SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, WORKSPACE.id]
  );
  if (!row) throw new ApiError(404, 'Project not found');
}

async function clearProjectLink(projectId: string): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    await assertProjectExists(projectId, tx);
    const existing = await readProjectLink(projectId, tx);
    if (!existing) return;
    const now = nowIso();
    const revision = existing.revision + 1;
    await tx.run(
      `UPDATE ext_everhour_project_links
          SET deleted_at = ?, updated_at = ?, revision = ?
        WHERE id = ? AND workspace_id = ? AND revision = ?`,
      [now, now, revision, existing.id, WORKSPACE.id, existing.revision]
    );
    await recordChange(
      {
        entityType: 'everhour:project_link',
        entityId: existing.id,
        operation: 'delete',
        entityRevision: revision,
        projectId,
        changedFields: ['linked']
      },
      tx
    );
  });
}

export async function getProjectEverhourLink(projectId: string): Promise<ProjectEverhourLinkDto> {
  await assertProjectExists(projectId);
  const link = await readProjectLink(projectId);
  return {
    projectId,
    everhourProjectId: link?.everhour_project_id ?? null,
    everhourProjectName: link?.everhour_project_name ?? null
  };
}

async function writeProjectLink(
  projectId: string,
  everhourProjectId: string,
  everhourProjectName: string,
  everhourSectionId: string | null
): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    await assertProjectExists(projectId, tx);
    const existing = await readProjectLink(projectId, tx);
    const now = nowIso();
    if (existing) {
      const revision = existing.revision + 1;
      await tx.run(
        `UPDATE ext_everhour_project_links
            SET everhour_project_id = ?, everhour_project_name = ?, everhour_section_id = ?,
                updated_at = ?, revision = ?
          WHERE id = ? AND workspace_id = ? AND revision = ?`,
        [
          everhourProjectId,
          everhourProjectName,
          everhourSectionId,
          now,
          revision,
          existing.id,
          WORKSPACE.id,
          existing.revision
        ]
      );
      await recordChange(
        {
          entityType: 'everhour:project_link',
          entityId: existing.id,
          operation: 'update',
          entityRevision: revision,
          projectId,
          changedFields: ['everhourProjectId', 'everhourProjectName', 'everhourSectionId']
        },
        tx
      );
      return;
    }

    const id = newId();
    await tx.run(
      `INSERT INTO ext_everhour_project_links
         (id, workspace_id, project_id, everhour_project_id, everhour_project_name,
          everhour_section_id, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id,
        WORKSPACE.id,
        projectId,
        everhourProjectId,
        everhourProjectName,
        everhourSectionId,
        now,
        now
      ]
    );
    await recordChange(
      {
        entityType: 'everhour:project_link',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        projectId,
        changedFields: ['linked', 'everhourProjectId', 'everhourProjectName', 'everhourSectionId']
      },
      tx
    );
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
  // Only reuse a *native* Everhour project. Matching an integration-synced
  // project here (e.g. a GitHub project that happens to share the name) would
  // silently break timer start later, since API task creation in those projects
  // is denied; fall through to creating a native board project instead.
  const match = unwrapArray<EverhourProject>(found).find(
    p =>
      p.name?.trim().toLowerCase() === name.trim().toLowerCase() && isNativeEverhourProjectId(p.id)
  );

  // Everhour returns 403 "Access denied" on section/task creation in a project the
  // API user is not a member of, so the linked project must list this user. Assign
  // them when creating, and backfill membership when reusing an existing project.
  const userId = await getCurrentEverhourUserId(apiKey);

  const project =
    match ??
    (await everhourFetch<EverhourProject>(apiKey, '/projects', {
      method: 'POST',
      body: { name, type: 'board', ...(userId !== null ? { users: [userId] } : {}) }
    }));

  if (match && userId !== null && !(match.users ?? []).includes(userId)) {
    await everhourFetch(apiKey, `/projects/${encodeURIComponent(match.id)}`, {
      method: 'PUT',
      body: {
        name: match.name,
        type: match.type ?? 'board',
        users: [...(match.users ?? []), userId]
      }
    });
  }

  return { id: project.id, sectionId: await resolveSectionId(apiKey, project.id) };
}

// Resolve a section to create tasks in (board projects require one). Reuses the
// first existing section, else creates an "Overlord" section. Only ever called for
// native Everhour projects (the link flow never binds to integration-synced ones),
// so a genuine API error here is a real problem and is allowed to propagate rather
// than being swallowed into a sectionless — and therefore invalid — task request.
async function resolveSectionId(apiKey: string, projectId: string): Promise<string | null> {
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
}

/**
 * Link (or unlink) the Overlord project to an Everhour project by name. Passing an
 * empty/blank name clears the link. Returns the refreshed extension link state.
 */
export async function linkProjectEverhour(
  projectId: string,
  rawName: string | null
): Promise<ProjectEverhourLinkDto> {
  const name = rawName?.trim() ?? '';
  if (!name) {
    await clearProjectLink(projectId);
    return { projectId, everhourProjectId: null, everhourProjectName: null };
  }

  const apiKey = await requireApiKey();
  const resolved = await resolveEverhourProject(apiKey, name);
  await writeProjectLink(projectId, resolved.id, name, resolved.sectionId);
  return { projectId, everhourProjectId: resolved.id, everhourProjectName: name };
}

// ---- mission ↔ task linking ----------------------------------------------

interface MissionRow {
  id: string;
  project_id: string;
  title: string;
  everhourTaskId: string | null;
}

async function getMissionRow(missionId: string): Promise<MissionRow> {
  const row = await requireDatabaseClient().get<Omit<MissionRow, 'everhourTaskId'>>(
    `SELECT id, project_id, title
       FROM missions WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [missionId, WORKSPACE.id]
  );
  if (!row) throw new ApiError(404, 'Mission not found');
  const link = await readMissionLink(missionId);
  return { ...row, everhourTaskId: link?.everhour_task_id ?? null };
}

async function getProjectEverhour(projectId: string): Promise<{
  everhourProjectId: string | null;
  sectionId: string | null;
}> {
  const link = await readProjectLink(projectId);
  if (!link) return { everhourProjectId: null, sectionId: null };
  return {
    everhourProjectId: link.everhour_project_id,
    sectionId: link.everhour_section_id
  };
}

async function readMissionLink(
  missionId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<MissionLinkRow | null> {
  const row = await client.get<MissionLinkRow>(
    `SELECT id, mission_id, everhour_task_id, revision
       FROM ext_everhour_mission_links
      WHERE mission_id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [missionId, WORKSPACE.id]
  );
  return row ?? null;
}

async function writeMissionTaskId(mission: MissionRow, taskId: string): Promise<void> {
  await requireDatabaseClient().transaction(async tx => {
    const existing = await readMissionLink(mission.id, tx);
    const now = nowIso();
    if (existing) {
      const revision = existing.revision + 1;
      await tx.run(
        `UPDATE ext_everhour_mission_links
            SET everhour_task_id = ?, updated_at = ?, revision = ?
          WHERE id = ? AND workspace_id = ? AND revision = ?`,
        [taskId, now, revision, existing.id, WORKSPACE.id, existing.revision]
      );
      await recordChange(
        {
          entityType: 'everhour:mission_link',
          entityId: existing.id,
          operation: 'update',
          entityRevision: revision,
          projectId: mission.project_id,
          missionId: mission.id,
          changedFields: ['everhourTaskId']
        },
        tx
      );
      return;
    }

    const id = newId();
    await tx.run(
      `INSERT INTO ext_everhour_mission_links
         (id, workspace_id, project_id, mission_id, everhour_task_id, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, WORKSPACE.id, mission.project_id, mission.id, taskId, now, now]
    );
    await recordChange(
      {
        entityType: 'everhour:mission_link',
        entityId: id,
        operation: 'insert',
        entityRevision: 1,
        projectId: mission.project_id,
        missionId: mission.id,
        changedFields: ['everhourTaskId']
      },
      tx
    );
  });
}

/**
 * Ensure the mission is linked to an Everhour task, creating one in the project's
 * linked Everhour project on first use. Throws when the project isn't linked.
 */
async function ensureMissionTask(apiKey: string, missionId: string): Promise<string> {
  const mission = await getMissionRow(missionId);
  if (mission.everhourTaskId) return mission.everhourTaskId;

  const { everhourProjectId, sectionId } = await getProjectEverhour(mission.project_id);
  if (!everhourProjectId) {
    throw new ApiError(
      400,
      'Link this project to an Everhour project in project settings before tracking time.'
    );
  }

  // A project linked to an integration source (GitHub/Jira/Asana/…) cannot host
  // API-created tasks, so the timer can never work against it. Fail fast with an
  // actionable message rather than letting the doomed POST surface a bare 403.
  if (!isNativeEverhourProjectId(everhourProjectId)) {
    throw new ApiError(
      400,
      'This project is linked to an integration-backed Everhour project (e.g. GitHub or Jira), ' +
        'which does not allow creating tasks via the API. Re-link it to a native Everhour project ' +
        'in project settings to track mission time.'
    );
  }

  // Everhour requires `section` when creating a board task (TaskRequest.section is
  // mandatory). The section is captured at link time, but resolve it on demand
  // when the stored link predates this requirement or the section was removed, so
  // we never POST a task missing its required field.
  const resolvedSectionId = sectionId ?? (await resolveSectionId(apiKey, everhourProjectId));
  if (!resolvedSectionId) {
    throw new ApiError(
      502,
      'Could not find or create an Everhour section to hold the mission task. ' +
        'Re-link the project to a native Everhour project in project settings, then try again.'
    );
  }

  const body: Record<string, unknown> = {
    name: mission.title || 'Untitled mission',
    section: Number(resolvedSectionId)
  };
  let task: EverhourTask;
  try {
    task = await everhourFetch<EverhourTask>(
      apiKey,
      `/projects/${encodeURIComponent(everhourProjectId)}/tasks`,
      { method: 'POST', body }
    );
  } catch (err) {
    // Safety net for any other access denial (e.g. a member-level API key): keep
    // the upstream detail but guide the user toward the likely fix.
    if (err instanceof ApiError && err.status === 403) {
      throw new ApiError(
        403,
        `Everhour denied creating a task for this mission (${err.message}). Confirm the linked ` +
          'Everhour project is a native project your API key can write to.'
      );
    }
    throw err;
  }
  if (!task?.id) throw new ApiError(502, 'Everhour did not return a task id.');
  await writeMissionTaskId(mission, task.id);
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
  const apiKey = await readEverhourApiKey();
  const mission = await getMissionRow(missionId);
  const { everhourProjectId } = await getProjectEverhour(mission.project_id);
  const base: MissionEverhourStateDto = {
    connected: Boolean(apiKey),
    projectLinked: Boolean(everhourProjectId),
    taskId: mission.everhourTaskId,
    records: [],
    totalSeconds: 0,
    runningTimer: null
  };
  if (!apiKey || !mission.everhourTaskId) return base;

  const [records, timer] = await Promise.all([
    listTaskRecords(apiKey, mission.everhourTaskId),
    getCurrentTimer(apiKey)
  ]);
  const runningDto = timer ? toTimerDto(timer) : null;
  return {
    ...base,
    records,
    totalSeconds: records.reduce((sum, r) => sum + r.timeSeconds, 0),
    runningTimer: runningDto && runningDto.taskId === mission.everhourTaskId ? runningDto : null
  };
}

/** Start (or restart) the Everhour timer for this mission's task. */
export async function startMissionTimer(missionId: string): Promise<MissionEverhourStateDto> {
  const apiKey = await requireApiKey();
  const taskId = await ensureMissionTask(apiKey, missionId);
  await everhourFetch(apiKey, '/timers', { method: 'POST', body: { task: taskId } });
  return getMissionEverhourState(missionId);
}

/** Stop the currently running Everhour timer (regardless of which task it's on). */
export async function stopMissionTimer(missionId: string): Promise<MissionEverhourStateDto> {
  const apiKey = await requireApiKey();
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
  const apiKey = await requireApiKey();
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
  const apiKey = await requireApiKey();
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
  const apiKey = await requireApiKey();
  await everhourFetch(apiKey, `/time/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
  return getMissionEverhourState(missionId);
}
