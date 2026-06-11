/**
 * Objective launch surface: workspace agent catalog, per-user launch configs,
 * project launch preferences, and execution-request queueing.
 *
 * Storage follows connectors/docs/agent-harness-configuration-architecture.md:
 *
 * - The workspace catalog (which agents/models are offered) lives in
 *   `workspaces.settings_json.agentCatalog`, seeded from a bundled default.
 * - Per-user launch mechanics (pre-command, flags) live on the user's
 *   `workspace_user_execution_targets.agent_flags_json` for the local target.
 * - Last selection per project lives in
 *   `project_user_preferences.preferences_json.launchPreference`.
 * - Explicit per-objective overrides live in `objectives.launch_config_json`,
 *   keyed by execution target then agent key.
 * - Queueing resolves the launch config (objective override → user target
 *   config → workspace default → empty) and snapshots it into
 *   `execution_requests.launch_flags_json` for the runner to consume verbatim.
 */
import { createHash } from 'node:crypto';
import { hostname, platform } from 'node:os';

import { resolveInstanceAgentCatalog } from '../../cli/src/agent-catalog.ts';
import { loadConfig } from '../../cli/src/config.ts';
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
  UpdateAgentLaunchConfigBody,
  UpdateLaunchPreferenceBody
} from '../shared/contract.ts';

import { ACTOR_WORKSPACE_USER_ID, db, newId, nowIso, recordChange, WORKSPACE } from './db.ts';
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

function instanceAgentCatalog(): Record<string, StoredCatalogAgent> {
  const config = loadConfig();
  return resolveInstanceAgentCatalog({ configCatalog: config.agentCatalog });
}

// ---- Workspace settings helpers --------------------------------------------

function readWorkspaceSettings(): Record<string, unknown> {
  const row = db
    .prepare(`SELECT settings_json FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
    .get(WORKSPACE.id) as { settings_json: string } | undefined;
  if (!row) throw new ApiError(500, 'Workspace not found');
  try {
    return JSON.parse(row.settings_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeWorkspaceSettings(settings: Record<string, unknown>): void {
  db.prepare(
    `UPDATE workspaces SET settings_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`
  ).run(JSON.stringify(settings), nowIso(), WORKSPACE.id);
}

function readStoredCatalog(): StoredCatalog | null {
  const settings = readWorkspaceSettings();
  const stored = settings[AGENT_CATALOG_SETTINGS_KEY] as StoredCatalog | undefined;
  if (!stored || typeof stored !== 'object' || typeof stored.agents !== 'object') return null;
  return stored;
}

function persistCatalog(catalog: StoredCatalog): void {
  const settings = readWorkspaceSettings();
  settings[AGENT_CATALOG_SETTINGS_KEY] = { ...catalog, updatedAt: nowIso() };
  writeWorkspaceSettings(settings);
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
export const getAgentCatalog = db.transaction((): AgentCatalogDto => {
  let stored = readStoredCatalog();
  if (!stored) {
    stored = { agents: instanceAgentCatalog() };
    persistCatalog(stored);
  }
  return toCatalogDto(stored);
});

/**
 * Merge the bundled default catalog into the workspace catalog: adds agents
 * and models that have shipped since the catalog was seeded while preserving
 * workspace customisations (labels, defaults, removed availability).
 */
export const refreshAgentCatalog = db.transaction((): AgentCatalogDto => {
  const stored = readStoredCatalog() ?? { agents: {} };
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
  persistCatalog(stored);
  return toCatalogDto(stored);
});

// ---- Local device / execution target provisioning -------------------------

interface LocalLaunchTarget {
  deviceId: string;
  deviceLabel: string;
  executionTargetId: string;
  /** workspace_user_execution_targets row id (null when there is no actor). */
  userTargetId: string | null;
  agentConfigs: Record<string, AgentLaunchConfigDto>;
}

function deviceFingerprint(): string {
  return createHash('sha256').update(`${hostname()}:${platform()}`).digest('hex').slice(0, 32);
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

/**
 * Resolve (provisioning on demand) the local device, its `local` execution
 * target, and the acting user's per-target config row. Mirrors the CLI's
 * device fingerprint so the web server and `ovld` agree on identity.
 */
const ensureLocalLaunchTarget = db.transaction((): LocalLaunchTarget => {
  const now = nowIso();
  const fingerprint = deviceFingerprint();

  let device = db
    .prepare(
      `SELECT id, label FROM devices
        WHERE workspace_id = ? AND fingerprint = ? AND deleted_at IS NULL`
    )
    .get(WORKSPACE.id, fingerprint) as { id: string; label: string } | undefined;
  if (!device) {
    const id = newId();
    const label = hostname();
    db.prepare(
      `INSERT INTO devices
         (id, workspace_id, fingerprint, label, platform, status, last_seen_at,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, 'active', ?, '{}', ?, ?, 1)`
    ).run(id, WORKSPACE.id, fingerprint, label, platform(), now, now, now);
    recordChange({ entityType: 'device', entityId: id, operation: 'insert', entityRevision: 1 });
    device = { id, label };
  } else {
    db.prepare(`UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?`).run(
      now,
      now,
      device.id
    );
  }

  let target = db
    .prepare(
      `SELECT id FROM execution_targets
        WHERE workspace_id = ? AND device_id = ? AND type = 'local' AND deleted_at IS NULL`
    )
    .get(WORKSPACE.id, device.id) as { id: string } | undefined;
  if (!target) {
    const id = newId();
    db.prepare(
      `INSERT INTO execution_targets
         (id, workspace_id, device_id, owner_workspace_user_id, type, label, status,
          connection_json, agent_flags_json, terminal_profile_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, 'local', ?, 'active', '{}', '{}', '{}', ?, ?, 1)`
    ).run(id, WORKSPACE.id, device.id, ACTOR_WORKSPACE_USER_ID, device.label, now, now);
    recordChange({
      entityType: 'execution_target',
      entityId: id,
      operation: 'insert',
      entityRevision: 1
    });
    target = { id };
  }

  let userTargetId: string | null = null;
  let agentConfigs: Record<string, AgentLaunchConfigDto> = {};
  if (ACTOR_WORKSPACE_USER_ID) {
    const userTarget = db
      .prepare(
        `SELECT id, agent_flags_json FROM workspace_user_execution_targets
          WHERE workspace_id = ? AND workspace_user_id = ? AND execution_target_id = ?
            AND deleted_at IS NULL`
      )
      .get(WORKSPACE.id, ACTOR_WORKSPACE_USER_ID, target.id) as
      | { id: string; agent_flags_json: string }
      | undefined;
    if (userTarget) {
      userTargetId = userTarget.id;
      agentConfigs = parseAgentConfigs(userTarget.agent_flags_json);
    } else {
      userTargetId = newId();
      db.prepare(
        `INSERT INTO workspace_user_execution_targets
           (id, workspace_id, workspace_user_id, execution_target_id, access_status,
            agent_flags_json, terminal_profile_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, 'active', '{}', '{}', ?, ?, 1)`
      ).run(userTargetId, WORKSPACE.id, ACTOR_WORKSPACE_USER_ID, target.id, now, now);
    }
  }

  return {
    deviceId: device.id,
    deviceLabel: device.label,
    executionTargetId: target.id,
    userTargetId,
    agentConfigs
  };
});

export function getLaunchSettings(): LaunchSettingsDto {
  const target = ensureLocalLaunchTarget();
  return {
    executionTargetId: target.executionTargetId,
    deviceLabel: target.deviceLabel,
    agentConfigs: target.agentConfigs
  };
}

/** Persist the acting user's launch mechanics (pre-command/flags) for one agent. */
export const updateAgentLaunchConfig = db.transaction(
  (agentKey: string, body: UpdateAgentLaunchConfigBody): LaunchSettingsDto => {
    const key = agentKey.trim();
    if (!key) throw new ApiError(400, 'Agent key is required');
    const target = ensureLocalLaunchTarget();
    if (!target.userTargetId) {
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

    db.prepare(
      `UPDATE workspace_user_execution_targets
          SET agent_flags_json = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?`
    ).run(JSON.stringify(configs), nowIso(), target.userTargetId);

    return {
      executionTargetId: target.executionTargetId,
      deviceLabel: target.deviceLabel,
      agentConfigs: configs
    };
  }
);

// ---- Project launch preference ---------------------------------------------

const LAUNCH_PREFERENCE_KEY = 'launchPreference';

function requireProject(projectId: string): void {
  const row = db
    .prepare(`SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .get(projectId, WORKSPACE.id);
  if (!row) throw new ApiError(404, 'Project not found');
}

function readPreferenceRow(
  projectId: string
): { id: string; preferences: Record<string, unknown>; revision: number } | null {
  if (!ACTOR_WORKSPACE_USER_ID) return null;
  const row = db
    .prepare(
      `SELECT id, preferences_json, revision FROM project_user_preferences
        WHERE workspace_id = ? AND project_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`
    )
    .get(WORKSPACE.id, projectId, ACTOR_WORKSPACE_USER_ID) as
    | { id: string; preferences_json: string; revision: number }
    | undefined;
  if (!row) return null;
  let preferences: Record<string, unknown>;
  try {
    preferences = JSON.parse(row.preferences_json) as Record<string, unknown>;
  } catch {
    preferences = {};
  }
  return { id: row.id, preferences, revision: row.revision };
}

export function getLaunchPreference(projectId: string): LaunchPreferenceDto {
  requireProject(projectId);
  const row = readPreferenceRow(projectId);
  const stored = row?.preferences[LAUNCH_PREFERENCE_KEY] as
    | Partial<LaunchPreferenceDto>
    | undefined;
  return {
    selectedAgent: stored?.selectedAgent ?? null,
    selectedModel: stored?.selectedModel ?? null,
    selectedReasoningEffort: stored?.selectedReasoningEffort ?? null
  };
}

export const updateLaunchPreference = db.transaction(
  (projectId: string, body: UpdateLaunchPreferenceBody): LaunchPreferenceDto => {
    requireProject(projectId);
    if (!ACTOR_WORKSPACE_USER_ID) {
      throw new ApiError(409, 'No active workspace user to store preferences for');
    }

    const row = readPreferenceRow(projectId);
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
      db.prepare(
        `UPDATE project_user_preferences
            SET preferences_json = ?, updated_at = ?, revision = revision + 1
          WHERE id = ?`
      ).run(JSON.stringify(preferences), now, row.id);
    } else {
      db.prepare(
        `INSERT INTO project_user_preferences
           (id, workspace_id, project_id, workspace_user_id, preferences_json,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(
        newId(),
        WORKSPACE.id,
        projectId,
        ACTOR_WORKSPACE_USER_ID,
        JSON.stringify({ [LAUNCH_PREFERENCE_KEY]: next }),
        now,
        now
      );
    }
    return next;
  }
);

// ---- Execution requests -----------------------------------------------------

interface ExecutionRequestRow {
  id: string;
  workspace_id: string;
  project_id: string;
  ticket_id: string;
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
    ticketId: r.ticket_id,
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

const EXECUTION_REQUEST_COLUMNS = `
  id, workspace_id, project_id, ticket_id, objective_id, execution_target_id,
  requested_agent, requested_model, requested_reasoning_effort, launch_flags_json,
  status, requested_source, last_error, created_at, updated_at
`;

/** Active (queued/claimed/launching) requests for a ticket, newest first per objective. */
export function listTicketExecutionRequests(ticketId: string): ExecutionRequestDto[] {
  const rows = db
    .prepare(
      `SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests
        WHERE ticket_id = ? AND status IN ('queued', 'claimed', 'launching')
          AND deleted_at IS NULL
        ORDER BY created_at DESC`
    )
    .all(ticketId) as ExecutionRequestRow[];
  return rows.map(toExecutionRequestDto);
}

interface LaunchObjectiveRow {
  id: string;
  workspace_id: string;
  project_id: string;
  ticket_id: string;
  title: string | null;
  instruction_text: string;
  state: string;
  assigned_agent: string | null;
  model: string | null;
  reasoning_effort: string | null;
  launch_config_json: string | null;
  revision: number;
}

const LAUNCHABLE_STATES = ['draft', 'submitted', 'launching'];

/**
 * Resolve the launch config for an objective + target + agent, most specific
 * source first (see "Launch Configuration Resolution" in the architecture doc):
 *
 * 1. `objectives.launch_config_json[targetId][agentKey]` — authoritative when present
 * 2. The user's per-target config (`workspace_user_execution_targets.agent_flags_json`)
 * 3. The workspace catalog's launch default for the agent
 * 4. Empty (no pre-command, no flags)
 */
function resolveLaunchConfig(
  objectiveLaunchConfigJson: string | null,
  executionTargetId: string,
  agentKey: string,
  userConfigs: Record<string, AgentLaunchConfigDto>
): { config: AgentLaunchConfigDto; source: 'objective' | 'user_target' | 'workspace' | 'none' } {
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

  const stored = readStoredCatalog();
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
 * `submitted`, and writes the `execution_requests` row plus the
 * `ticket_events` / `entity_changes` records in one transaction.
 */
export const launchObjective = db.transaction(
  (objectiveId: string, body: LaunchObjectiveBody): ExecutionRequestDto => {
    const agentKey = (body.agent ?? '').trim();
    if (!agentKey) throw new ApiError(400, 'agent is required');

    const objective = db
      .prepare(
        `SELECT id, workspace_id, project_id, ticket_id, title, instruction_text, state,
                assigned_agent, model, reasoning_effort, launch_config_json, revision
           FROM objectives
          WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
      )
      .get(objectiveId, WORKSPACE.id) as LaunchObjectiveRow | undefined;
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

    const target = ensureLocalLaunchTarget();
    const now = nowIso();

    // Persist the selection (and explicit override) onto the objective so the
    // queue snapshot and the objective row never disagree about what was asked.
    const model = body.model ?? null;
    const reasoningEffort = body.reasoningEffort ?? null;
    const fields: string[] = [];
    const params: Record<string, unknown> = { id: objective.id };
    const changed: string[] = [];
    if (objective.assigned_agent !== agentKey) {
      fields.push('assigned_agent = @assigned_agent');
      params.assigned_agent = agentKey;
      changed.push('assigned_agent');
    }
    if (objective.model !== model) {
      fields.push('model = @model');
      params.model = model;
      changed.push('model');
    }
    if (objective.reasoning_effort !== reasoningEffort) {
      fields.push('reasoning_effort = @reasoning_effort');
      params.reasoning_effort = reasoningEffort;
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
      fields.push('launch_config_json = @launch_config_json');
      params.launch_config_json = launchConfigJson;
      changed.push('launch_config_json');
    }
    if (objective.state === 'draft') {
      fields.push(`state = 'submitted'`);
      changed.push('state');
    }

    let revision = objective.revision;
    if (fields.length > 0) {
      revision += 1;
      db.prepare(
        `UPDATE objectives SET ${fields.join(', ')}, updated_at = @now, revision = @revision
           WHERE id = @id`
      ).run({ ...params, now, revision });
      recordChange({
        entityType: 'objective',
        entityId: objective.id,
        operation: 'update',
        entityRevision: revision,
        projectId: objective.project_id,
        ticketId: objective.ticket_id,
        objectiveId: objective.id,
        changedFields: changed
      });
    }

    const resolved = resolveLaunchConfig(
      launchConfigJson,
      target.executionTargetId,
      agentKey,
      target.agentConfigs
    );

    const requestId = newId();
    db.prepare(
      `INSERT INTO execution_requests
         (id, workspace_id, project_id, ticket_id, objective_id, execution_target_id,
          requested_agent, requested_model, requested_reasoning_effort,
          launch_mode, launch_flags_json, target_kind, requested_source, status,
          requested_by_workspace_user_id, metadata_json, created_at, updated_at, revision)
       VALUES (@id, @ws, @project_id, @ticket_id, @objective_id, @execution_target_id,
          @requested_agent, @requested_model, @requested_reasoning_effort,
          'run', @launch_flags_json, 'local', 'webapp', 'queued',
          @actor, @metadata_json, @now, @now, 1)`
    ).run({
      id: requestId,
      ws: WORKSPACE.id,
      project_id: objective.project_id,
      ticket_id: objective.ticket_id,
      objective_id: objective.id,
      execution_target_id: target.executionTargetId,
      requested_agent: agentKey,
      requested_model: model,
      requested_reasoning_effort: reasoningEffort,
      launch_flags_json: JSON.stringify(resolved.config),
      metadata_json: JSON.stringify({ launchConfigSource: resolved.source }),
      actor: ACTOR_WORKSPACE_USER_ID,
      now
    });

    db.prepare(
      `INSERT INTO ticket_events
         (id, workspace_id, project_id, ticket_id, objective_id, type, phase, summary,
          payload_json, source, actor_workspace_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'execution_requested', 'execute', ?, ?, 'webapp', ?, ?)`
    ).run(
      newId(),
      WORKSPACE.id,
      objective.project_id,
      objective.ticket_id,
      objective.id,
      `Queued ${agentKey}${model ? ` (${model})` : ''} execution for a runner.`,
      JSON.stringify({ executionRequestId: requestId, agent: agentKey, model, reasoningEffort }),
      ACTOR_WORKSPACE_USER_ID,
      now
    );

    recordChange({
      entityType: 'execution_request',
      entityId: requestId,
      operation: 'insert',
      entityRevision: 1,
      projectId: objective.project_id,
      ticketId: objective.ticket_id,
      objectiveId: objective.id
    });

    const row = db
      .prepare(`SELECT ${EXECUTION_REQUEST_COLUMNS} FROM execution_requests WHERE id = ?`)
      .get(requestId) as ExecutionRequestRow;
    return toExecutionRequestDto(row);
  }
);

// ---- Copyable prompt --------------------------------------------------------

/**
 * Assemble a prompt the user can paste into an agent they start themselves.
 * Mirrors the shape of the context `ovld launch` hands to agents: the
 * objective, ticket identity, and the protocol attach instruction.
 */
export function getObjectivePrompt(objectiveId: string): ObjectivePromptDto {
  const row = db
    .prepare(
      `SELECT o.id, o.ticket_id, o.title, o.instruction_text,
              t.display_id, t.title AS ticket_title
         FROM objectives o
         JOIN tickets t ON t.id = o.ticket_id
        WHERE o.id = ? AND o.workspace_id = ? AND o.deleted_at IS NULL`
    )
    .get(objectiveId, WORKSPACE.id) as
    | {
        id: string;
        ticket_id: string;
        title: string | null;
        instruction_text: string;
        display_id: string;
        ticket_title: string;
      }
    | undefined;
  if (!row) throw new ApiError(404, 'Objective not found');

  const prompt = [
    `# Overlord Agent Instructions`,
    ``,
    `You are an AI coding agent working on ticket **${row.display_id}** via Overlord.`,
    `Complete the work described below, then deliver a summary back to the platform.`,
    ``,
    `## Task`,
    ``,
    `- **Title:** ${row.ticket_title}`,
    `- **Ticket ID:** ${row.display_id}`,
    `- **Objective ID:** ${row.id}`,
    ``,
    `### Objective`,
    ``,
    row.instruction_text,
    ``,
    `## Overlord Protocol`,
    ``,
    `Attach to this ticket before doing anything else, then post updates while you`,
    `work and deliver a summary when you finish:`,
    ``,
    '```bash',
    `ovld protocol attach --ticket-id ${row.display_id}`,
    '```'
  ].join('\n');

  return { objectiveId: row.id, ticketId: row.ticket_id, prompt };
}
