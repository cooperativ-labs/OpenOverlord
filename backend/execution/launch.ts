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
import { type Permission, PERMISSIONS } from '@overlord/auth';
import type { ServiceContext } from '@overlord/core/service/context';
import type { TerminalProfile } from '@overlord/core/service/terminal-profile-types';
import type { DatabaseClient } from '@overlord/database';

import { resolveInstanceAgentCatalog } from '../../cli/src/agent-catalog.ts';
import { loadConfig } from '../../cli/src/config.ts';
import {
  ACTIVE_EXECUTION_REQUEST_STATUSES,
  clearExecutionRequests,
  createExecutionRequest,
  type ExecutionRequestSummary
} from '../../packages/core/service/execution-requests.ts';
import {
  ensureActingDeviceTarget,
  updateTerminalProfile as persistTerminalProfile
} from '../../packages/core/service/execution-targets.ts';
import {
  LOCAL_TARGET_MUTATION_REQUESTED_SOURCE,
  parseLocalTargetMutation
} from '../../packages/core/service/local-target-mutations.ts';
import {
  parseAgentConfigs,
  readProjectUserPreferenceRow,
  resolveLaunchConfig,
  resolveLaunchExecutionTarget
} from '../../packages/core/service/project-execution-target.ts';
import { assertLaunchResourceConnected } from '../../packages/core/service/projects.ts';
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
  UpdateAgentCatalogBody,
  UpdateAgentLaunchConfigBody,
  UpdateLaunchPreferenceBody,
  UpdateTerminalProfileBody,
  UpdateWorktreeBranchAutomationBody
} from '../../webapp/shared/contract.ts';
import {
  buildWebappServiceContext,
  buildWebappServiceContextForWorkspace,
  findActiveMembershipId,
  getActorWorkspaceUserId,
  newId,
  nowIso,
  recordChange,
  requireDatabaseClient,
  resolveActiveProfileId,
  serviceDatabaseClient,
  WORKSPACE
} from '../db.ts';
import { ApiError } from '../errors.ts';
import { actorCan, requireProjectPermission, requireWorkspacePermission } from '../rbac.ts';

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
  client: DatabaseClient = requireDatabaseClient(),
  workspaceId: string
): Promise<Record<string, unknown>> {
  const row = await client.get<{ settings_json: string }>(
    `SELECT settings_json FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    [workspaceId]
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
  client: DatabaseClient = requireDatabaseClient(),
  workspaceId: string
): Promise<void> {
  await client.run(
    `UPDATE workspaces SET settings_json = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
    [JSON.stringify(settings), nowIso(), workspaceId]
  );
}

async function readStoredCatalog(
  client: DatabaseClient,
  workspaceId: string
): Promise<StoredCatalog | null> {
  const settings = await readWorkspaceSettings(client, workspaceId);
  const stored = settings[AGENT_CATALOG_SETTINGS_KEY] as StoredCatalog | undefined;
  if (!stored || typeof stored !== 'object' || typeof stored.agents !== 'object') return null;
  return stored;
}

async function persistCatalog(
  catalog: StoredCatalog,
  client: DatabaseClient,
  workspaceId: string
): Promise<void> {
  const settings = await readWorkspaceSettings(client, workspaceId);
  settings[AGENT_CATALOG_SETTINGS_KEY] = { ...catalog, updatedAt: nowIso() };
  await writeWorkspaceSettings(settings, client, workspaceId);
}

/**
 * Resolve which workspace a catalog operation targets. An explicit
 * `workspaceId` is authorized against the caller's own membership in *that*
 * workspace (coo:96/coo:135 pattern — independent of the active one, 404 for
 * non-members); omitted, it falls back to the request's active workspace,
 * whose route-level permission gate has already run.
 */
async function resolveCatalogWorkspaceId(
  workspaceId: string | undefined,
  permission: Permission,
  db: DatabaseClient
): Promise<string> {
  if (!workspaceId) return WORKSPACE.id;
  await requireWorkspacePermission({
    workspaceId,
    permission,
    db,
    notFoundMessage: 'Workspace not found or no active membership'
  });
  return workspaceId;
}

/**
 * Whether worktree/branch automation is enabled for `workspaceId`. Every caller
 * derives the workspace from the resource it already loaded — mission-detail
 * assembly passes the mission's own workspace, and the launch-settings surface
 * passes the scope's workspace — so a secondary workspace's setting, not the
 * active one's, governs its missions (coo:135/coo:331).
 */
export async function readWorktreeBranchAutomationEnabled(
  client: DatabaseClient = requireDatabaseClient(),
  workspaceId: string
): Promise<boolean> {
  const settings = await readWorkspaceSettings(client, workspaceId);
  return settings[WORKTREE_BRANCH_AUTOMATION_SETTINGS_KEY] === true;
}

async function launchSettingsDto({
  target,
  workspaceId,
  agentConfigs = target.agentConfigs,
  terminalProfile = target.terminalProfile,
  client = requireDatabaseClient()
}: {
  target: Awaited<ReturnType<typeof ensureLocalLaunchTarget>>;
  workspaceId: string;
  agentConfigs?: Record<string, AgentLaunchConfigDto>;
  terminalProfile?: TerminalProfileDto;
  client?: DatabaseClient;
}): Promise<LaunchSettingsDto> {
  return {
    executionTargetId: target.executionTargetId,
    deviceLabel: target.deviceLabel,
    agentConfigs,
    terminalProfile,
    worktreeBranchAutomationEnabled: await readWorktreeBranchAutomationEnabled(client, workspaceId)
  };
}

/**
 * Resolve the `(workspace, ServiceContext)` a launch-settings operation targets.
 * An explicit `workspaceId` is authorized against the caller's *own* membership
 * in that workspace (coo:135 pattern — 404 for non-members) and yields a context
 * bound to it, so a secondary-workspace mission's launch config is read/written
 * in **its** workspace — matching where `launchObjective` resolves it. Omitted →
 * the request's active workspace (back-compat), whose route-level permission gate
 * has already run. Mirrors `resolveCatalogWorkspaceId`, but also carries the
 * membership-bound context (§2.1) needed to provision the acting-device target.
 */
async function resolveLaunchSettingsScope(
  workspaceId: string | undefined,
  permission: Permission,
  client: DatabaseClient
): Promise<{ workspaceId: string; ctx: ServiceContext }> {
  if (!workspaceId) {
    const ctx = serviceContext(client);
    return { workspaceId: ctx.workspace.id, ctx };
  }
  const membershipId = await requireWorkspacePermission({
    workspaceId,
    permission,
    db: client,
    notFoundMessage: 'Workspace not found or no active membership'
  });
  const ctx = await buildWebappServiceContextForWorkspace(workspaceId, client, membershipId);
  return { workspaceId, ctx };
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

/**
 * Read a workspace's agent catalog, seeding it from the bundled default on
 * first use. Defaults to the request's active workspace; an explicit
 * `workspaceId` targets any workspace the caller is a member of.
 */
export async function getAgentCatalog(workspaceId?: string): Promise<AgentCatalogDto> {
  return requireDatabaseClient().transaction(async tx => {
    const targetWorkspaceId = await resolveCatalogWorkspaceId(
      workspaceId,
      PERMISSIONS.LAUNCH_READ,
      tx
    );
    let stored = await readStoredCatalog(tx, targetWorkspaceId);
    if (!stored) {
      stored = { agents: instanceAgentCatalog() };
      await persistCatalog(stored, tx, targetWorkspaceId);
    }
    return toCatalogDto(stored);
  });
}

/**
 * Merge the bundled default catalog into the workspace catalog: adds agents
 * and models that have shipped since the catalog was seeded while preserving
 * workspace customisations (labels, defaults, removed availability).
 */
export async function refreshAgentCatalog(workspaceId?: string): Promise<AgentCatalogDto> {
  return requireDatabaseClient().transaction(async tx => {
    const targetWorkspaceId = await resolveCatalogWorkspaceId(
      workspaceId,
      PERMISSIONS.LAUNCH_CONFIGURE,
      tx
    );
    const stored = (await readStoredCatalog(tx, targetWorkspaceId)) ?? { agents: {} };
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
    await persistCatalog(stored, tx, targetWorkspaceId);
    return toCatalogDto(stored);
  });
}

function storedCatalogFromBody(body: UpdateAgentCatalogBody): StoredCatalog {
  if (!body || !Array.isArray(body.agents)) {
    throw new ApiError(400, 'agents array is required');
  }

  const agents: Record<string, StoredCatalogAgent> = {};

  for (const agent of body.agents) {
    const key = agent.key?.trim();
    if (!key) throw new ApiError(400, 'Each agent must have a key');
    const label = agent.label?.trim();
    if (!label) throw new ApiError(400, `Agent ${key} must have a label`);
    if (!Array.isArray(agent.models) || agent.models.length === 0) {
      throw new ApiError(400, `Agent ${key} must have at least one model`);
    }

    const modelIds = new Set<string>();
    const models = agent.models.map(model => {
      const id = model.id?.trim();
      if (!id) throw new ApiError(400, `Model id is required for agent ${key}`);
      if (modelIds.has(id)) {
        throw new ApiError(400, `Duplicate model id ${id} in agent ${key}`);
      }
      modelIds.add(id);
      return {
        id,
        displayName: model.displayName?.trim() || id,
        reasoningOptions: Array.isArray(model.reasoningOptions)
          ? model.reasoningOptions
              .map(option => (typeof option === 'string' ? option.trim() : ''))
              .filter(option => option.length > 0)
          : []
      };
    });

    if (
      agent.defaultModel !== null &&
      agent.defaultModel !== undefined &&
      !modelIds.has(agent.defaultModel)
    ) {
      throw new ApiError(400, `defaultModel must reference a model id in agent ${key}`);
    }

    if (
      agent.defaultReasoningEffort !== null &&
      agent.defaultReasoningEffort !== undefined &&
      agent.defaultModel !== null &&
      agent.defaultModel !== undefined
    ) {
      const defaultModel = models.find(model => model.id === agent.defaultModel);
      if (
        defaultModel &&
        defaultModel.reasoningOptions.length > 0 &&
        !defaultModel.reasoningOptions.includes(agent.defaultReasoningEffort)
      ) {
        throw new ApiError(
          400,
          `defaultReasoningEffort must be one of the default model's reasoning options for agent ${key}`
        );
      }
    }

    agents[key] = {
      label,
      availableByDefault: agent.availableByDefault !== false,
      models,
      defaultModel: agent.defaultModel ?? null,
      defaultReasoningEffort: agent.defaultReasoningEffort ?? null,
      reasoningLabel: agent.reasoningLabel?.trim() || 'Thinking'
    };
  }

  return { agents };
}

/** Replace the workspace agent catalog with a validated client payload. */
export async function updateAgentCatalog(
  body: UpdateAgentCatalogBody,
  workspaceId?: string
): Promise<AgentCatalogDto> {
  return requireDatabaseClient().transaction(async tx => {
    const targetWorkspaceId = await resolveCatalogWorkspaceId(
      workspaceId,
      PERMISSIONS.LAUNCH_CONFIGURE,
      tx
    );
    const stored = storedCatalogFromBody(body);
    const existing = (await readStoredCatalog(tx, targetWorkspaceId)) ?? { agents: {} };

    for (const [key, agent] of Object.entries(stored.agents)) {
      const previous = existing.agents[key];
      if (previous?.launchDefaults) {
        agent.launchDefaults = previous.launchDefaults;
      }
    }

    await persistCatalog(stored, tx, targetWorkspaceId);
    return toCatalogDto(stored);
  });
}

// ---- Local device / execution target provisioning -------------------------

function serviceContext(client: DatabaseClient = serviceDatabaseClient()) {
  return buildWebappServiceContext(client);
}

function toTerminalProfileDto(profile: TerminalProfile): TerminalProfileDto {
  return {
    launcher: profile.launcher ?? null,
    placement: profile.placement ?? 'window',
    chord: profile.chord ?? null
  };
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

async function ensureLocalLaunchTarget(
  client: DatabaseClient = requireDatabaseClient(),
  ctx: ServiceContext = serviceContext(client)
): Promise<{
  deviceId: string;
  deviceLabel: string;
  executionTargetId: string;
  userTargetId: string | null;
  preferenceId: string | null;
  agentConfigs: Record<string, AgentLaunchConfigDto>;
  terminalProfile: TerminalProfileDto;
}> {
  const target = await ensureActingDeviceTarget({ ctx });
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

export async function getLaunchSettings(workspaceId?: string): Promise<LaunchSettingsDto> {
  const client = requireDatabaseClient();
  const scope = await resolveLaunchSettingsScope(workspaceId, PERMISSIONS.LAUNCH_READ, client);
  const target = await ensureLocalLaunchTarget(client, scope.ctx);
  return launchSettingsDto({ target, workspaceId: scope.workspaceId, client });
}

/** Persist the acting user's launch mechanics (pre-command/flags) for one agent. */
export async function updateAgentLaunchConfig(
  agentKey: string,
  body: UpdateAgentLaunchConfigBody,
  workspaceId?: string
): Promise<LaunchSettingsDto> {
  return requireDatabaseClient().transaction(async tx => {
    const key = agentKey.trim();
    if (!key) throw new ApiError(400, 'Agent key is required');
    const scope = await resolveLaunchSettingsScope(workspaceId, PERMISSIONS.LAUNCH_CONFIGURE, tx);
    const target = await ensureLocalLaunchTarget(tx, scope.ctx);
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

    return launchSettingsDto({
      target,
      workspaceId: scope.workspaceId,
      agentConfigs: configs,
      client: tx
    });
  });
}

/** Persist the acting user's terminal profile for the local execution target. */
export async function updateTerminalProfile(
  body: UpdateTerminalProfileBody,
  workspaceId?: string
): Promise<LaunchSettingsDto> {
  return requireDatabaseClient().transaction(async tx => {
    const scope = await resolveLaunchSettingsScope(workspaceId, PERMISSIONS.LAUNCH_CONFIGURE, tx);
    const saved = await persistTerminalProfile({
      ctx: scope.ctx,
      profile: {
        launcher: body.launcher ?? null,
        placement: body.placement ?? 'window',
        chord: body.placement === 'chord' ? (body.chord ?? null) : null
      }
    });
    const target = await ensureLocalLaunchTarget(tx, scope.ctx);
    return launchSettingsDto({
      target: {
        ...target,
        executionTargetId: saved.executionTargetId,
        deviceLabel: saved.deviceLabel
      },
      workspaceId: scope.workspaceId,
      terminalProfile: toTerminalProfileDto(saved.terminalProfile),
      client: tx
    });
  });
}

export async function updateWorktreeBranchAutomation(
  body: UpdateWorktreeBranchAutomationBody,
  workspaceId?: string
): Promise<LaunchSettingsDto> {
  return requireDatabaseClient().transaction(async tx => {
    const scope = await resolveLaunchSettingsScope(workspaceId, PERMISSIONS.LAUNCH_CONFIGURE, tx);
    const settings = await readWorkspaceSettings(tx, scope.workspaceId);
    settings[WORKTREE_BRANCH_AUTOMATION_SETTINGS_KEY] = body.enabled === true;
    await writeWorkspaceSettings(settings, tx, scope.workspaceId);
    const target = await ensureLocalLaunchTarget(tx, scope.ctx);
    return launchSettingsDto({ target, workspaceId: scope.workspaceId, client: tx });
  });
}

// ---- Project launch preference ---------------------------------------------

const LAUNCH_PREFERENCE_KEY = 'launchPreference';

function readPreferenceRow(
  projectId: string,
  workspaceId: string,
  workspaceUserId: string | null,
  client: DatabaseClient = requireDatabaseClient()
): Promise<{ id: string; preferences: Record<string, unknown>; revision: number } | null> {
  return readProjectUserPreferenceRow({
    db: client,
    workspaceId,
    workspaceUserId,
    projectId
  });
}

export async function getLaunchPreference(
  projectId: string,
  client: DatabaseClient = requireDatabaseClient()
): Promise<LaunchPreferenceDto> {
  const { workspaceId, workspaceUserId } = await requireProjectPermission({
    projectId,
    permission: PERMISSIONS.LAUNCH_READ,
    db: client
  });
  const row = await readPreferenceRow(projectId, workspaceId, workspaceUserId, client);
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
    const { workspaceId, workspaceUserId } = await requireProjectPermission({
      projectId,
      permission: PERMISSIONS.LAUNCH_CONFIGURE,
      db: tx
    });

    const row = await readPreferenceRow(projectId, workspaceId, workspaceUserId, tx);
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
          workspaceId,
          projectId,
          workspaceUserId,
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
  metadata_json: string;
  status: string;
  requested_source: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function parseMetadataJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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

function executionRequestMutationKind(
  requestedSource: string,
  metadata: Record<string, unknown>
): ExecutionRequestDto['localTargetMutationKind'] {
  if (requestedSource !== LOCAL_TARGET_MUTATION_REQUESTED_SOURCE) return null;
  const mutation = parseLocalTargetMutation(metadata);
  return mutation?.kind ?? null;
}

function toExecutionRequestDto(r: ExecutionRequestRow): ExecutionRequestDto {
  const metadata = parseMetadataJson(r.metadata_json);
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
    localTargetMutationKind: executionRequestMutationKind(r.requested_source, metadata),
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
    localTargetMutationKind: executionRequestMutationKind(r.requestedSource, r.metadata),
    lastError: r.lastError,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  };
}

const EXECUTION_REQUEST_COLUMNS = `
  id, workspace_id, project_id, mission_id, objective_id, execution_target_id,
  requested_agent, requested_model, requested_reasoning_effort, launch_flags_json,
  metadata_json, status, requested_source, last_error, created_at, updated_at
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
  resource_key: string | null;
  revision: number;
}

export const LAUNCHABLE_STATES = ['draft', 'submitted', 'launching'];
const ACTIVE_SIBLING_OBJECTIVE_STATES = ['launching', 'executing', 'pending_delivery'];

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
  workspaceId,
  workspaceUserId,
  reason,
  newState,
  now,
  tx = requireDatabaseClient()
}: {
  objectiveId: string;
  projectId: string;
  missionId: string;
  /** The objective's own workspace — not the caller's active one (coo:135). */
  workspaceId: string;
  workspaceUserId: string | null;
  /** Why the objective left the queue, for the audit event payload. */
  reason: 'completed' | 'disconnected' | 'deleted';
  /** New objective state, or null when the objective is being deleted. */
  newState: string | null;
  now: string;
  tx?: DatabaseClient;
}): Promise<{ clearedRequests: number; endedSessions: number }> {
  const { cleared } = await clearExecutionRequests({
    ctx: {
      ...(await buildWebappServiceContextForWorkspace(workspaceId, tx, workspaceUserId)),
      db: tx
    },
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
    [workspaceId, objectiveId]
  );

  for (const session of openSessions) {
    const revision = session.revision + 1;
    await tx.run(
      `UPDATE agent_sessions
         SET phase = ?, ended_at = ?, updated_at = ?, revision = ?
       WHERE id = ? AND workspace_id = ?`,
      [sessionPhase, now, now, revision, session.id, workspaceId]
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
        changedFields: ['phase', 'ended_at'],
        workspaceId,
        actorWorkspaceUserId: workspaceUserId
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
        workspaceId,
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
        workspaceUserId,
        now
      ]
    );
  }

  return { clearedRequests: cleared, endedSessions: openSessions.length };
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
                assigned_agent, model, reasoning_effort, launch_config_json, resource_key, revision
           FROM objectives
          WHERE id = ? AND deleted_at IS NULL`,
      [objectiveId]
    );
    if (!objective) throw new ApiError(404, 'Objective not found');

    const profileId = await resolveActiveProfileId(tx);
    const workspaceUserId = profileId
      ? await findActiveMembershipId(objective.workspace_id, profileId, tx)
      : null;
    if (
      !workspaceUserId ||
      !(await actorCan(PERMISSIONS.EXECUTION_REQUEST_CREATE, {
        workspaceId: objective.workspace_id,
        workspaceUserId
      }))
    ) {
      throw new ApiError(404, 'Objective not found');
    }

    if (!LAUNCHABLE_STATES.includes(objective.state)) {
      throw new ApiError(
        409,
        `Objective is not launchable from state "${objective.state}"`,
        objective.state === 'future'
          ? 'Promote the objective to draft first.'
          : 'Only draft, submitted, or launching objectives can be queued.'
      );
    }

    const activeSiblingObjective = await tx.get<{ id: string }>(
      `SELECT id FROM objectives
          WHERE mission_id = ? AND workspace_id = ? AND id <> ? AND deleted_at IS NULL
            AND state IN (${ACTIVE_SIBLING_OBJECTIVE_STATES.map(() => '?').join(', ')})
          LIMIT 1`,
      [
        objective.mission_id,
        objective.workspace_id,
        objective.id,
        ...ACTIVE_SIBLING_OBJECTIVE_STATES
      ]
    );
    const activeSiblingRequest = await tx.get<{ id: string }>(
      `SELECT er.id
           FROM execution_requests er
           JOIN objectives o ON o.id = er.objective_id AND o.deleted_at IS NULL
          WHERE er.mission_id = ? AND er.workspace_id = ? AND er.objective_id <> ?
            AND er.deleted_at IS NULL
            AND er.status IN (${ACTIVE_EXECUTION_REQUEST_STATUSES.map(() => '?').join(', ')})
            AND o.state IN (${ACTIVE_SIBLING_OBJECTIVE_STATES.map(() => '?').join(', ')})
          LIMIT 1`,
      [
        objective.mission_id,
        objective.workspace_id,
        objective.id,
        ...ACTIVE_EXECUTION_REQUEST_STATUSES,
        ...ACTIVE_SIBLING_OBJECTIVE_STATES
      ]
    );
    if (activeSiblingObjective || activeSiblingRequest) {
      throw new ApiError(
        409,
        'Another objective on this mission is already active. Enable auto-advance on this objective instead of queueing it for the runner.'
      );
    }

    const serviceCtx = await buildWebappServiceContextForWorkspace(
      objective.workspace_id,
      tx,
      workspaceUserId
    );
    const launchTarget = await resolveLaunchExecutionTarget({
      ctx: serviceCtx,
      projectId: objective.project_id
    });
    const { executionTargetId, agentConfigs } = launchTarget;
    const now = nowIso();

    await assertLaunchResourceConnected({
      ctx: serviceCtx,
      projectId: objective.project_id,
      objectiveResourceKey: objective.resource_key,
      executionTargetId
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
    if (
      executionTargetId &&
      body.launchConfigOverride !== undefined &&
      body.launchConfigOverride !== null
    ) {
      let parsed: Record<string, Record<string, unknown>>;
      try {
        parsed = launchConfigJson
          ? (JSON.parse(launchConfigJson) as Record<string, Record<string, unknown>>)
          : {};
      } catch {
        parsed = {};
      }
      parsed[executionTargetId] = {
        ...(parsed[executionTargetId] ?? {}),
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

    const resolved = await resolveLaunchConfig({
      ctx: serviceCtx,
      objectiveLaunchConfigJson: launchConfigJson,
      executionTargetId,
      agentKey,
      userConfigs: agentConfigs
    });

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
      ctx: serviceCtx,
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
      // WS-C (R3): stamp the project's selected execution target (or the sole
      // eligible target). NULL still means "any eligible target may claim."
      executionTargetId,
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
  const db = requireDatabaseClient();
  // `objectives.id` is a globally-unique UUID, so this resolves independent of
  // the caller's active workspace (coo:135) — the objective's own workspace,
  // not necessarily the request's active one, since the caller may be viewing
  // a secondary workspace's mission. Permission is then checked against that
  // resolved workspace, mirroring `requireObjectivePermission` in repository.ts.
  const row = await db.get<{
    id: string;
    mission_id: string;
    title: string | null;
    instruction_text: string;
    display_id: string;
    mission_title: string;
    workspace_id: string;
  }>(
    `SELECT o.id, o.mission_id, o.title, o.instruction_text, o.workspace_id,
              t.display_id, t.title AS mission_title
         FROM objectives o
         JOIN missions t ON t.id = o.mission_id
        WHERE o.id = ? AND o.deleted_at IS NULL`,
    [objectiveId]
  );
  if (!row) throw new ApiError(404, 'Objective not found');

  const profileId = await resolveActiveProfileId(db);
  const workspaceUserId = profileId
    ? await findActiveMembershipId(row.workspace_id, profileId, db)
    : null;
  if (
    !workspaceUserId ||
    !(await actorCan(PERMISSIONS.OBJECTIVE_READ, {
      workspaceId: row.workspace_id,
      workspaceUserId
    }))
  ) {
    throw new ApiError(404, 'Objective not found');
  }

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
