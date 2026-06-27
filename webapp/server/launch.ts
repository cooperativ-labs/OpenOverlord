/**
 * Objective launch surface: workspace agent catalog, per-user launch configs,
 * project launch preferences, and execution-request queueing.
 *
 * Storage follows connectors/docs/agent-harness-configuration-architecture.md:
 *
 * - The workspace catalog (which agents/models are offered) lives in
 *   `workspaces.settings_json.agentCatalog`, seeded from a bundled default.
 * - Per-user launch mechanics (pre-command, flags) live on the user's
 *   `user_execution_target_preferences.agent_configs_json` for the local target fingerprint.
 * - Last selection per project lives in
 *   `project_user_preferences.preferences_json.launchPreference`.
 * - Explicit per-objective overrides live in `objectives.launch_config_json`,
 *   keyed by execution target then agent key.
 * - Queueing resolves the launch config (objective override → user target
 *   config → workspace default → empty) and snapshots it into
 *   `execution_requests.launch_flags_json` for the runner to consume verbatim.
 */
import type { DatabaseClient } from '@overlord/database';

import { resolveInstanceAgentCatalog } from '../../cli/src/agent-catalog.ts';
import { loadConfig } from '../../cli/src/config.ts';
import type { TerminalProfile } from '../../cli/src/terminal-profile-types.ts';
import {
  ACTIVE_EXECUTION_REQUEST_STATUSES,
  clearExecutionRequests,
  createExecutionRequest,
  type ExecutionRequestSummary
} from '../../packages/core/service/execution-requests.ts';
import {
  ensureLocalExecutionTarget,
  updateTerminalProfile as persistTerminalProfile
} from '../../packages/core/service/execution-targets.ts';
import { assertPrimaryResourceConnected } from '../../packages/core/service/projects.ts';
import type {
  AgentCatalogAgentDto,
  AgentCatalogDto,
  AgentLaunchConfigDto,
  ExecutionRequestDto,
  ExecutionRequestStatus,
  LaunchObjectiveBody,
  LaunchPreferenceDto,
  LaunchSettingsDto,
  ObjectivePromptDto,
  TerminalProfileDto,
  UpdateAgentLaunchConfigBody,
  UpdateLaunchPreferenceBody,
  UpdateTerminalProfileBody,
  UpdateWorktreeBranchAutomationBody
} from '../shared/contract.ts';

import {
  getActorWorkspaceUserId,
  newId,
  nowIso,
  recordChange,
  requireDatabaseClient,
  serviceDatabaseClient,
  WORKSPACE
} from './db.ts';
import { ApiError } from './errors.ts';

// ---- Instance default catalog ----------------------------------------------
//
// Seeded into `workspaces.settings_json.agentCatalog` from bundled defaults
// plus optional `[agent_catalog]` in overlord.toml, and re-merged by the
// "refresh" endpoint so new defaults appear without wiping workspace edits.
// Keys match the connector registry (`cli/src/connectors.ts`).

interface StoredCatalogAgent {
  label: string;
  availableByDefault: boolean;
  models: Array<{ id: string; displayName: string; reasoningOptions: string[] }>;
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  reasoningLabel: string;
  /** Optional workspace-wide launch default (lowest-priority config source). */
  launchDefaults?: AgentLaunchConfigDto;
}

type StoredCatalog = {
  agents: Record<string, StoredCatalogAgent>;
  updatedAt?: string;
};

const AGENT_CATALOG_SETTINGS_KEY = 'agentCatalog';
const WORKTREE_BRANCH_AUTOMATION_SETTINGS_KEY = 'worktreeBranchAutomationEnabled';

function instanceAgentCatalog(): Record<string, StoredCatalogAgent> {
  const config = loadConfig();
  return resolveInstanceAgentCatalog({ configCatalog: config.agentCatalog });
}

// ---- Workspace settings helpers --------------------------------------------

async function readWorkspaceSettings(
  client: DatabaseClient = requireDatabaseClient()
): Promise<Record<string, unknown>> {
  const row = await client.get<{ settings_json: string }>(
    `SELECT settings_json FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    [WORKSPACE.id]
  );
  if (!row) throw new ApiError(500, 'Workspace not found');
  try {
    return JSON.parse(row.settings_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeWorkspaceSettings(
  settings: Record<string, unknown>,
  client: DatabaseClient = requireDatabaseClient()
): Promise<void> {
  await client.run(
    `UPDATE workspaces SET settings_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
    [JSON.stringify(settings), nowIso(), WORKSPACE.id]
  );
}

async function readStoredCatalog(
  client: DatabaseClient = requireDatabaseClient()
): Promise<StoredCatalog | null> {
  const settings = await readWorkspaceSettings(client);
  const stored = settings[AGENT_CATALOG_SETTINGS_KEY] as StoredCatalog | undefined;
  if (!stored || typeof stored !== 'object' || typeof stored.agents !== 'object') return null;
  return stored;
}

async function persistCatalog(
  catalog: StoredCatalog,
  client: DatabaseClient = requireDatabaseClient()
): Promise<void> {
  const settings = await readWorkspaceSettings(client);
  settings[AGENT_CATALOG_SETTINGS_KEY] = { ...catalog, updatedAt: nowIso() };
  await writeWorkspaceSettings(settings, client);
}

export async function readWorktreeBranchAutomationEnabled(
  client: DatabaseClient = requireDatabaseClient()
): Promise<boolean> {
  const settings = await readWorkspaceSettings(client);
  return settings[WORKTREE_BRANCH_AUTOMATION_SETTINGS_KEY] === true;
}

async function launchSettingsDto({
  target,
  agentConfigs = target.agentConfigs,
  terminalProfile = target.terminalProfile,
  client = requireDatabaseClient()
}: {
  target: Awaited<ReturnType<typeof ensureLocalLaunchTarget>>;
  agentConfigs?: Record<string, AgentLaunchConfigDto>;
  terminalProfile?: TerminalProfileDto;
  client?: DatabaseClient;
}): Promise<LaunchSettingsDto> {
  return {
    executionTargetId: target.executionTargetId,
    deviceLabel: target.deviceLabel,
    agentConfigs,
    terminalProfile,
    worktreeBranchAutomationEnabled: await readWorktreeBranchAutomationEnabled(client)
  };
}

function toCatalogDto(stored: StoredCatalog): AgentCatalogDto {
  const config = loadConfig();
  const agents: AgentCatalogAgentDto[] = Object.entries(stored.agents).map(([key, agent]) => ({
    key,
    label: agent.label,
    availableByDefault: agent.availableByDefault !== false,
    models: (agent.models ?? []).map(m => ({
      id: m.id,
      displayName: m.displayName ?? m.id,
      reasoningOptions: Array.isArray(m.reasoningOptions) ? m.reasoningOptions : []
    })),
    defaultModel: agent.defaultModel ?? null,
    defaultReasoningEffort: agent.defaultReasoningEffort ?? null,
    reasoningLabel: agent.reasoningLabel ?? 'Thinking'
  }));
  return {
    agents,
    defaultAgent: config.defaultAgent,
    defaultModel: config.defaultModel
  };
}

/** Read the workspace agent catalog, seeding it from the bundled default on first use. */
export async function getAgentCatalog(): Promise<AgentCatalogDto> {
  return requireDatabaseClient().transaction(async tx => {
    let stored = await readStoredCatalog(tx);
    if (!stored) {
      stored = { agents: instanceAgentCatalog() };
      await persistCatalog(stored, tx);
    }
    return toCatalogDto(stored);
  });
}

/**
 * Merge the bundled default catalog into the workspace catalog: adds agents
 * and models that have shipped since the catalog was seeded while preserving
 * workspace customisations (labels, defaults, removed availability).
 */
export async function refreshAgentCatalog(): Promise<AgentCatalogDto> {
  return requireDatabaseClient().transaction(async tx => {
    const stored = (await readStoredCatalog(tx)) ?? { agents: {} };
    for (const [key, bundled] of Object.entries(instanceAgentCatalog())) {
      const existing = stored.agents[key];
      if (!existing) {
        stored.agents[key] = structuredClone(bundled);
        continue;
      }
      const knownIds = new Set((existing.models ?? []).map(m => m.id));
      for (const model of bundled.models) {
        if (!knownIds.has(model.id)) existing.models.push(structuredClone(model));
      }
    }
    await persistCatalog(stored, tx);
    return toCatalogDto(stored);
  });
}

// ---- Local device / execution target provisioning -------------------------

function serviceContext(client: DatabaseClient = serviceDatabaseClient()) {
  return {
    db: client,
    workspace: { id: WORKSPACE.id, slug: WORKSPACE.slug, name: WORKSPACE.name },
    actorWorkspaceUserId: getActorWorkspaceUserId(),
    source: 'webapp' as const
  };
}

function toTerminalProfileDto(profile: TerminalProfile): TerminalProfileDto {
  return {
    launcher: profile.launcher ?? null,
    placement: profile.placement ?? 'window',
    chord: profile.chord ?? null
  };
}

function parseAgentConfigs(json: string): Record<string, AgentLaunchConfigDto> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
  const configs: Record<string, AgentLaunchConfigDto> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue;
    const config = value as { preCommand?: unknown; flags?: unknown };
    configs[key] = {
      preCommand: typeof config.preCommand === 'string' ? config.preCommand : '',
      flags: Array.isArray(config.flags) ? config.flags.filter(f => typeof f === 'string') : []
    };
  }
  return configs;
}

async function readAgentConfigs(
  preferenceId: string | null,
  client: DatabaseClient = requireDatabaseClient()
): Promise<Record<string, AgentLaunchConfigDto>> {
  if (!preferenceId) return {};
  const row = await client.get<{ agent_configs_json: string }>(
    `SELECT agent_configs_json FROM user_execution_target_preferences WHERE id = ?`,
    [preferenceId]
  );
  return row ? parseAgentConfigs(row.agent_configs_json) : {};
}

async function ensureLocalLaunchTarget(client: DatabaseClient = requireDatabaseClient()): Promise<{
  deviceId: string;
  deviceLabel: string;
  executionTargetId: string;
  userTargetId: string | null;
  preferenceId: string | null;
  agentConfigs: Record<string, AgentLaunchConfigDto>;
  terminalProfile: TerminalProfileDto;
}> {
  const target = await ensureLocalExecutionTarget({ ctx: serviceContext(client) });
  return {
    deviceId: target.deviceId,
    deviceLabel: target.deviceLabel,
    executionTargetId: target.executionTargetId,
    userTargetId: target.userTargetId,
    preferenceId: target.preferenceId,
    agentConfigs: await readAgentConfigs(target.preferenceId, client),
    terminalProfile: toTerminalProfileDto(target.terminalProfile)
  };
}

export async function getLaunchSettings(): Promise<LaunchSettingsDto> {
  const target = await ensureLocalLaunchTarget();
  return launchSettingsDto({ target });
}

/** Persist the acting user's launch mechanics (pre-command/flags) for one agent. */
export async function updateAgentLaunchConfig(
  agentKey: string,
  body: UpdateAgentLaunchConfigBody
): Promise<LaunchSettingsDto> {
  return requireDatabaseClient().transaction(async tx => {
    const key = agentKey.trim();
    if (!key) throw new ApiError(400, 'Agent key is required');
    const target = await ensureLocalLaunchTarget(tx);
    if (!target.preferenceId) {
      throw new ApiError(409, 'No active workspace user to store launch configs for');
    }

    const next: AgentLaunchConfigDto = {
      preCommand:
        body.preCommand !== undefined
          ? body.preCommand.trim()
          : (target.agentConfigs[key]?.preCommand ?? ''),
      flags:
        body.flags !== undefined
          ? body.flags.map(f => f.trim()).filter(f => f.length > 0)
          : (target.agentConfigs[key]?.flags ?? [])
    };
    const configs = { ...target.agentConfigs, [key]: next };

    await tx.run(
      `UPDATE user_execution_target_preferences
          SET agent_configs_json = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?`,
      [JSON.stringify(configs), nowIso(), target.preferenceId]
    );

    return launchSettingsDto({ target, agentConfigs: configs, client: tx });
  });
}

/** Persist the acting user's terminal profile for the local execution target. */
export async function updateTerminalProfile(
  body: UpdateTerminalProfileBody
): Promise<LaunchSettingsDto> {
  return requireDatabaseClient().transaction(async tx => {
    const saved = await persistTerminalProfile({
      ctx: serviceContext(tx),
      profile: {
        launcher: body.launcher ?? null,
        placement: body.placement ?? 'window',
        chord: body.placement === 'chord' ? (body.chord ?? null) : null
      }
    });
    const target = await ensureLocalLaunchTarget(tx);
    return launchSettingsDto({
      target: {
        ...target,
        executionTargetId: saved.executionTargetId,
        deviceLabel: saved.deviceLabel
      },
      terminalProfile: toTerminalProfileDto(saved.terminalProfile),
      client: tx
    });
  });
}

export async function updateWorktreeBranchAutomation(
  body: UpdateWorktreeBranchAutomationBody
): Promise<LaunchSettingsDto> {
  return requireDatabaseClient().transaction(async tx => {
    const settings = await readWorkspaceSettings(tx);
    settings[WORKTREE_BRANCH_AUTOMATION_SETTINGS_KEY] = body.enabled === true;
    await writeWorkspaceSettings(settings, tx);
    const target = await ensureLocalLaunchTarget(tx);
    return launchSettingsDto({ target, client: tx });
  });
}

// ---- Project launch preference ---------------------------------------------

const LAUNCH_PREFERENCE_KEY = 'launchPreference';

async function requireProject(
  projectId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<void> {
  const row = await client.get(
    `SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, WORKSPACE.id]
  );
  if (!row) throw new ApiError(404, 'Project not found');
}

async function readPreferenceRow(
  projectId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<{ id: string; preferences: Record<string, unknown>; revision: number } | null> {
  if (!getActorWorkspaceUserId()) return null;
  const row = await client.get<{ id: string; preferences_json: string; revision: number }>(
    `SELECT id, preferences_json, revision FROM project_user_preferences
        WHERE workspace_id = ? AND project_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
    [WORKSPACE.id, projectId, getActorWorkspaceUserId()]
  );
  if (!row) return null;
  let preferences: Record<string, unknown>;
  try {
    preferences = JSON.parse(row.preferences_json) as Record<string, unknown>;
  } catch {
    preferences = {};
  }
  return { id: row.id, preferences, revision: row.revision };
}

export async function getLaunchPreference(
  projectId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<LaunchPreferenceDto> {
  await requireProject(projectId, client);
  const row = await readPreferenceRow(projectId, client);
  const stored = row?.preferences[LAUNCH_PREFERENCE_KEY] as
    | Partial<LaunchPreferenceDto>
    | undefined;
  return {
    selectedAgent: stored?.selectedAgent ?? null,
    selectedModel: stored?.selectedModel ?? null,
    selectedReasoningEffort: stored?.selectedReasoningEffort ?? null
  };
}

export async function updateLaunchPreference(
  projectId: string,
  body: UpdateLaunchPreferenceBody
): Promise<LaunchPreferenceDto> {
  return requireDatabaseClient().transaction(async tx => {
    await requireProject(projectId, tx);
    if (!getActorWorkspaceUserId()) {
      throw new ApiError(409, 'No active workspace user to store preferences for');
    }

    const row = await readPreferenceRow(projectId, tx);
    const current = (row?.preferences[LAUNCH_PREFERENCE_KEY] ?? {}) as Partial<LaunchPreferenceDto>;
    const next: LaunchPreferenceDto = {
      selectedAgent:
        body.selectedAgent !== undefined ? body.selectedAgent : (current.selectedAgent ?? null),
      selectedModel:
        body.selectedModel !== undefined ? body.selectedModel : (current.selectedModel ?? null),
      selectedReasoningEffort:
        body.selectedReasoningEffort !== undefined
          ? body.selectedReasoningEffort
          : (current.selectedReasoningEffort ?? null)
    };

    const now = nowIso();
    if (row) {
      const preferences = { ...row.preferences, [LAUNCH_PREFERENCE_KEY]: next };
      await tx.run(
        `UPDATE project_user_preferences
            SET preferences_json = ?, updated_at = ?, revision = revision + 1
          WHERE id = ?`,
        [JSON.stringify(preferences), now, row.id]
      );
    } else {
      await tx.run(
        `INSERT INTO project_user_preferences
           (id, workspace_id, project_id, workspace_user_id, preferences_json,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          newId(),
          WORKSPACE.id,
          projectId,
          getActorWorkspaceUserId(),
          JSON.stringify({ [LAUNCH_PREFERENCE_KEY]: next }),
          now,
          now
        ]
      );
    }
    return next;
  });
}

// ---- Execution requests -----------------------------------------------------

interface ExecutionRequestRow {
  id: string;
  workspace_id: string;
  project_id: string;
  mission_id: string;
  objective_id: string;
  execution_target_id: string | null;
  requested_agent: string | null;
  requested_model: string | null;
  requested_reasoning_effort: string | null;
  launch_flags_json: string;
  status: string;
  requested_source: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function parseLaunchConfig(json: string): AgentLaunchConfigDto {
  try {
    const parsed = JSON.parse(json) as { preCommand?: unknown; flags?: unknown };
    return {
      preCommand: typeof parsed.preCommand === 'string' ? parsed.preCommand : '',
      flags: Array.isArray(parsed.flags) ? parsed.flags.filter(f => typeof f === 'string') : []
    };
  } catch {
    return { preCommand: '', flags: [] };
  }
}

function toExecutionRequestDto(r: ExecutionRequestRow): ExecutionRequestDto {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    missionId: r.mission_id,
    objectiveId: r.objective_id,
    executionTargetId: r.execution_target_id,
    requestedAgent: r.requested_agent,
    requestedModel: r.requested_model,
    requestedReasoningEffort: r.requested_reasoning_effort,
    launchConfig: parseLaunchConfig(r.launch_flags_json),
    status: r.status as ExecutionRequestStatus,
    requestedSource: r.requested_source,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function executionSummaryToDto(r: ExecutionRequestSummary): ExecutionRequestDto {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    projectId: r.projectId,
    missionId: r.missionId,
    objectiveId: r.objectiveId,
    executionTargetId: r.executionTargetId,
    requestedAgent: r.requestedAgent,
    requestedModel: r.requestedModel,
    requestedReasoningEffort: r.requestedReasoningEffort,
    launchConfig: {
      preCommand: typeof r.launchFlags.preCommand === 'string' ? r.launchFlags.preCommand : '',
      flags: Array.isArray(r.launchFlags.flags)
        ? r.launchFlags.flags.filter((f): f is string => typeof f === 'string')
        : []
    },
    status: r.status as ExecutionRequestStatus,
    requestedSource: r.requestedSource,
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  };
}

const EXECUTION_REQUEST_COLUMNS = `
  id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
  requested_agent, requested_model, requested_reasoning_effort, launch_flags_json,
  status, requested_source, last_error, created_at, updated_at
`;

/** Active (queued/claimed/launching) requests for a mission, newest first per objective. */
export async function listMissionExecutionRequests(
  missionId: string
): Promise<ExecutionRequestDto[]> {
  const rows = await requireDatabaseClient().all<ExecutionRequestRow>(
    `SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests
        WHERE mission_id = ?
          AND status IN (${ACTIVE_EXECUTION_REQUEST_STATUSES.map(() => '?').join(', ')})
          AND deleted_at IS NULL
        ORDER BY created_at DESC`,
    [missionId, ...ACTIVE_EXECUTION_REQUEST_STATUSES]
  );
  return rows.map(toExecutionRequestDto);
}

interface LaunchObjectiveRow {
  id: string;
  workspace_id: string;
  project_id: string;
  mission_id: string;
  title: string | null;
  instruction_text: string;
  state: string;
  assigned_agent: string | null;
  model: string | null;
  reasoning_effort: string | null;
  launch_config_json: string | null;
  revision: number;
}

export const LAUNCHABLE_STATES = ['draft', 'submitted', 'launching'];

/**
 * Remove an objective from the runner queue when a user manually completes,
 * disconnects, or deletes it in the UI. Clears any active (queued/claimed/
 * launching) execution requests so a runner never claims work the user has
 * stopped, and ends any still-open agent session bound to the objective so the
 * session status reflects the new objective state.
 *
 * Must be called inside the caller's transaction so the objective mutation and
 * these queue/session updates land atomically. Returns the counts so callers
 * can decide whether to surface them.
 */
export async function dequeueObjective({
  objectiveId,
  projectId,
  missionId,
  reason,
  newState,
  now,
  tx = requireDatabaseClient()
}: {
  objectiveId: string;
  projectId: string;
  missionId: string;
  /** Why the objective left the queue, for the audit event payload. */
  reason: 'completed' | 'disconnected' | 'deleted';
  /** New objective state, or null when the objective is being deleted. */
  newState: string | null;
  now: string;
  tx?: DatabaseClient;
}): Promise<{ clearedRequests: number; endedSessions: number }> {
  const { cleared } = await clearExecutionRequests({
    ctx: { ...serviceContext(), db: tx },
    objectiveId,
    now,
    emitEvents: false
  });

  // A completed objective ends its session cleanly; a disconnect/delete leaves
  // it blocked since the agent never reached a delivery.
  const sessionPhase = newState === 'complete' ? 'complete' : 'blocked';
  const openSessions = await tx.all<{ id: string; revision: number }>(
    `SELECT id, revision FROM agent_sessions
        WHERE workspace_id = ? AND objective_id = ? AND deleted_at IS NULL
          AND ended_at IS NULL`,
    [WORKSPACE.id, objectiveId]
  );

  for (const session of openSessions) {
    const revision = session.revision + 1;
    await tx.run(
      `UPDATE agent_sessions
         SET phase = ?, ended_at = ?, updated_at = ?, revision = ?
       WHERE id = ? AND workspace_id = ?`,
      [sessionPhase, now, now, revision, session.id, WORKSPACE.id]
    );
    await recordChange(
      {
        entityType: 'agent_session',
        entityId: session.id,
        operation: 'update',
        entityRevision: revision,
        projectId,
        missionId,
        objectiveId,
        changedFields: ['phase', 'ended_at']
      },
      tx
    );
  }

  if (cleared > 0 || openSessions.length > 0) {
    await tx.run(
      `INSERT INTO mission_events
         (id, workspace_id, project_id, mission_id, objective_id, type, phase, summary,
          payload_json, source, actor_workspace_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'status_change', NULL, ?, ?, 'webapp', ?, ?)`,
      [
        newId(),
        WORKSPACE.id,
        projectId,
        missionId,
        objectiveId,
        `Objective ${reason}: cleared ${cleared} queued execution request(s) ` +
          `and ended ${openSessions.length} active session(s).`,
        JSON.stringify({
          reason,
          newState,
          clearedRequests: cleared,
          endedSessions: openSessions.length
        }),
        getActorWorkspaceUserId(),
        now
      ]
    );
  }

  return { clearedRequests: cleared, endedSessions: openSessions.length };
}

/**
 * Resolve the launch config for an objective + target + agent, most specific
 * source first (see "Launch Configuration Resolution" in the architecture doc):
 *
 * 1. `objectives.launch_config_json[targetId][agentKey]` — authoritative when present
 * 2. The user's per-target config (`user_execution_target_preferences.agent_configs_json`)
 * 3. The workspace catalog's launch default for the agent
 * 4. Empty (no pre-command, no flags)
 */
async function resolveLaunchConfig(
  objectiveLaunchConfigJson: string | null,
  executionTargetId: string,
  agentKey: string,
  userConfigs: Record<string, AgentLaunchConfigDto>,
  client: DatabaseClient = requireDatabaseClient()
): Promise<{
  config: AgentLaunchConfigDto;
  source: 'objective' | 'user_target' | 'workspace' | 'none';
}> {
  if (objectiveLaunchConfigJson) {
    try {
      const parsed = JSON.parse(objectiveLaunchConfigJson) as Record<
        string,
        Record<string, unknown>
      >;
      const override = parsed?.[executionTargetId]?.[agentKey];
      if (override && typeof override === 'object') {
        const cast = override as { preCommand?: unknown; flags?: unknown };
        return {
          config: {
            preCommand: typeof cast.preCommand === 'string' ? cast.preCommand : '',
            flags: Array.isArray(cast.flags) ? cast.flags.filter(f => typeof f === 'string') : []
          },
          source: 'objective'
        };
      }
    } catch {
      /* treat unparseable override as absent */
    }
  }

  if (userConfigs[agentKey]) {
    return { config: userConfigs[agentKey], source: 'user_target' };
  }

  const stored = await readStoredCatalog(client);
  const workspaceDefault = stored?.agents[agentKey]?.launchDefaults;
  if (workspaceDefault) {
    return {
      config: {
        preCommand: workspaceDefault.preCommand ?? '',
        flags: Array.isArray(workspaceDefault.flags) ? workspaceDefault.flags : []
      },
      source: 'workspace'
    };
  }

  return { config: { preCommand: '', flags: [] }, source: 'none' };
}

/**
 * Queue an execution request for an objective. Persists the agent/model
 * selection onto the objective, stores an explicit launch override when one is
 * supplied, resolves the effective launch config, moves a draft objective to
 * `launching`, and writes the `execution_requests` row plus the
 * `mission_events` / `entity_changes` records in one transaction.
 */
export async function launchObjective(
  objectiveId: string,
  body: LaunchObjectiveBody
): Promise<ExecutionRequestDto> {
  return requireDatabaseClient().transaction(async tx => {
    const agentKey = (body.agent ?? '').trim();
    if (!agentKey) throw new ApiError(400, 'agent is required');

    const objective = await tx.get<LaunchObjectiveRow>(
      `SELECT id, workspace_id, project_id, mission_id, title, instruction_text, state,
                assigned_agent, model, reasoning_effort, launch_config_json, revision
           FROM objectives
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      [objectiveId, WORKSPACE.id]
    );
    if (!objective) throw new ApiError(404, 'Objective not found');
    if (!LAUNCHABLE_STATES.includes(objective.state)) {
      throw new ApiError(
        409,
        `Objective is not launchable from state "${objective.state}"`,
        objective.state === 'future'
          ? 'Promote the objective to draft first.'
          : 'Only draft, submitted, or launching objectives can be queued.'
      );
    }

    const target = await ensureLocalLaunchTarget(tx);
    const now = nowIso();

    await assertPrimaryResourceConnected({
      ctx: serviceContext(tx),
      projectId: objective.project_id,
      executionTargetId: target.executionTargetId
    });

    // Persist the selection (and explicit override) onto the objective so the
    // queue snapshot and the objective row never disagree about what was asked.
    const model = body.model ?? null;
    const reasoningEffort = body.reasoningEffort ?? null;
    const fields: string[] = [];
    const setParams: unknown[] = [];
    const changed: string[] = [];
    if (objective.assigned_agent !== agentKey) {
      fields.push('assigned_agent = ?');
      setParams.push(agentKey);
      changed.push('assigned_agent');
    }
    if (objective.model !== model) {
      fields.push('model = ?');
      setParams.push(model);
      changed.push('model');
    }
    if (objective.reasoning_effort !== reasoningEffort) {
      fields.push('reasoning_effort = ?');
      setParams.push(reasoningEffort);
      changed.push('reasoning_effort');
    }
    let launchConfigJson = objective.launch_config_json;
    if (body.launchConfigOverride !== undefined && body.launchConfigOverride !== null) {
      let parsed: Record<string, Record<string, unknown>>;
      try {
        parsed = launchConfigJson
          ? (JSON.parse(launchConfigJson) as Record<string, Record<string, unknown>>)
          : {};
      } catch {
        parsed = {};
      }
      parsed[target.executionTargetId] = {
        ...(parsed[target.executionTargetId] ?? {}),
        [agentKey]: {
          preCommand: body.launchConfigOverride.preCommand ?? '',
          flags: body.launchConfigOverride.flags ?? []
        }
      };
      launchConfigJson = JSON.stringify(parsed);
      fields.push('launch_config_json = ?');
      setParams.push(launchConfigJson);
      changed.push('launch_config_json');
    }
    if (objective.state === 'draft') {
      fields.push(`state = 'launching'`);
      changed.push('state');
    }

    let revision = objective.revision;
    if (fields.length > 0) {
      revision += 1;
      await tx.run(
        `UPDATE objectives SET ${fields.join(', ')}, updated_at = ?, revision = ?
           WHERE id = ?`,
        [...setParams, now, revision, objective.id]
      );
      await recordChange(
        {
          entityType: 'objective',
          entityId: objective.id,
          operation: 'update',
          entityRevision: revision,
          projectId: objective.project_id,
          missionId: objective.mission_id,
          objectiveId: objective.id,
          changedFields: changed
        },
        tx
      );
    }

    const resolved = await resolveLaunchConfig(
      launchConfigJson,
      target.executionTargetId,
      agentKey,
      target.agentConfigs,
      tx
    );

    // An objective stays in `launching` state until the runner claims and
    // launches its request; a second Run click in that window must not queue
    // a duplicate. Once the prior request reaches a terminal status, this
    // check clears and a relaunch is allowed.
    const activeRequestRow = await tx.get<ExecutionRequestRow>(
      `SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests
          WHERE objective_id = ? AND deleted_at IS NULL
            AND status IN (${ACTIVE_EXECUTION_REQUEST_STATUSES.map(() => '?').join(', ')})
          ORDER BY created_at DESC LIMIT 1`,
      [objective.id, ...ACTIVE_EXECUTION_REQUEST_STATUSES]
    );
    if (activeRequestRow) {
      return toExecutionRequestDto(activeRequestRow);
    }

    const request = await createExecutionRequest({
      ctx: serviceContext(tx),
      missionId: objective.mission_id,
      objectiveId: objective.id,
      requestedAgent: agentKey,
      requestedModel: model,
      requestedReasoningEffort: reasoningEffort,
      launchFlags: {
        preCommand: resolved.config.preCommand,
        flags: resolved.config.flags
      },
      requestedSource: 'webapp',
      executionTargetId: target.executionTargetId,
      metadata: { launchConfigSource: resolved.source },
      eventSummary: `Queued ${agentKey}${model ? ` (${model})` : ''} execution for a runner.`,
      eventPayload: { agent: agentKey, model, reasoningEffort }
    });
    return executionSummaryToDto(request);
  });
}

// ---- Copyable prompt --------------------------------------------------------

/**
 * Assemble a prompt the user can paste into an agent they start themselves.
 * Mirrors the shape of the context `ovld launch` hands to agents: the
 * objective, mission identity, and the protocol attach instruction.
 */
export async function getObjectivePrompt(objectiveId: string): Promise<ObjectivePromptDto> {
  const row = await requireDatabaseClient().get<{
    id: string;
    mission_id: string;
    title: string | null;
    instruction_text: string;
    display_id: string;
    mission_title: string;
  }>(
    `SELECT o.id, o.mission_id, o.title, o.instruction_text,
              t.display_id, t.title AS mission_title
         FROM objectives o
         JOIN missions t ON t.id = o.mission_id
        WHERE o.id = ? AND o.workspace_id = ? AND o.deleted_at IS NULL`,
    [objectiveId, WORKSPACE.id]
  );
  if (!row) throw new ApiError(404, 'Objective not found');

  const prompt = [
    `# Overlord Agent Instructions`,
    ``,
    `You are an AI coding agent working on mission **${row.display_id}** via Overlord.`,
    `Complete the work described below, then deliver a summary back to the platform.`,
    ``,
    `## Task`,
    ``,
    `- **Title:** ${row.mission_title}`,
    `- **Mission ID:** ${row.display_id}`,
    `- **Objective ID:** ${row.id}`,
    ``,
    `### Objective`,
    ``,
    row.instruction_text,
    ``,
    `## Overlord Protocol`,
    ``,
    `Attach to this mission before doing anything else, then post updates while you`,
    `work and deliver a summary when you finish:`,
    ``,
    '```bash',
    `ovld protocol attach --mission-id ${row.display_id}`,
    '```'
  ].join('\n');

  return { objectiveId: row.id, missionId: row.mission_id, prompt };
}
