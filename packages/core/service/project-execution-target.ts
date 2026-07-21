import { type AgentLaunchFlagDto, normalizeAgentLaunchFlags } from '@overlord/contract';
import type { DatabaseClient } from '@overlord/database';

import { isCoLocatedBackend } from './local-target/index.js';
import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { ServiceError } from './errors.js';
import {
  findActingDeviceExecutionTargetId,
  isBackendHostFingerprint,
  isBrowserDevicePlatform
} from './execution-targets.js';
import { findPrimaryProjectResource } from './projects.js';
import { newId, nowIso } from './util.js';

/** `project_user_preferences.preferences_json` key for WS-C target selection. */
export const PROJECT_EXECUTION_TARGET_PREFERENCE_KEY = 'selectedExecutionTargetId';

export type AgentLaunchConfig = {
  preCommand: string;
  flags: AgentLaunchFlagDto[];
};

export type LaunchExecutionTargetResolution = {
  /** Target stamped on the queued request; null means any eligible target may claim. */
  executionTargetId: string | null;
  /** Per-agent launch mechanics for the stamped target; empty when `executionTargetId` is null. */
  agentConfigs: Record<string, AgentLaunchConfig>;
};

/** Targets without a recent heartbeat are treated as offline for the selector UI. */
const TARGET_REACHABLE_STALE_MS = 5 * 60 * 1000;

export type EligibleExecutionTarget = {
  executionTargetId: string;
  type: string;
  label: string;
  deviceLabel: string | null;
  reachable: boolean;
  /** Whether this target has a non-missing primary resource for the project. */
  primaryResourceConnected: boolean;
};

export type ProjectExecutionTargetSelection = {
  selectedExecutionTargetId: string | null;
  eligibleTargets: EligibleExecutionTarget[];
};

export type WorkspaceExecutionTarget = {
  id: string;
  type: string;
  label: string;
  status: string;
  ownerDisplayName: string | null;
  reachable: boolean;
  lastSeenAt: string | null;
  activeMemberAccessCount: number;
  hasCurrentUserAccess: boolean;
};

function requireActor(ctx: ServiceContext): string {
  if (!ctx.actorWorkspaceUserId) {
    throw new ServiceError(
      'No active workspace user to store execution-target preferences for',
      'no_actor',
      409
    );
  }
  return ctx.actorWorkspaceUserId;
}

export type ProjectUserPreferenceRow = {
  id: string;
  preferences: Record<string, unknown>;
  revision: number;
};

/**
 * Shared accessor for a `(workspace_user, project)` row in
 * `project_user_preferences`. Returns null when there is no acting user or no
 * stored row, and tolerates malformed `preferences_json` by falling back to an
 * empty object. Both the core ServiceContext callers and the webapp's
 * module-global plumbing route through this single reader.
 */
export async function readProjectUserPreferenceRow({
  db,
  workspaceId,
  workspaceUserId,
  projectId
}: {
  db: DatabaseClient;
  workspaceId: string;
  workspaceUserId: string | null;
  projectId: string;
}): Promise<ProjectUserPreferenceRow | null> {
  if (!workspaceUserId) return null;
  const row = await db.get<{ id: string; preferences_json: string; revision: number }>(
    `SELECT id, preferences_json, revision FROM project_user_preferences
        WHERE workspace_id = ? AND project_id = ? AND workspace_user_id = ? AND deleted_at IS NULL`,
    [workspaceId, projectId, workspaceUserId]
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

function readPreferenceRow(
  ctx: ServiceContext,
  projectId: string
): Promise<ProjectUserPreferenceRow | null> {
  return readProjectUserPreferenceRow({
    db: ctx.db,
    workspaceId: ctx.workspace.id,
    workspaceUserId: ctx.actorWorkspaceUserId,
    projectId
  });
}

function readStoredExecutionTargetId(preferences: Record<string, unknown>): string | null {
  const stored = preferences[PROJECT_EXECUTION_TARGET_PREFERENCE_KEY];
  if (typeof stored !== 'string') return null;
  const trimmed = stored.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isTargetReachable({
  lastSeenAt,
  isCallerDevice
}: {
  lastSeenAt: string | null;
  isCallerDevice: boolean;
}): boolean {
  if (isCallerDevice) return true;
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < TARGET_REACHABLE_STALE_MS;
}

/**
 * Safe workspace-wide target projection for settings. The caller must already
 * be authorized as a member of `ctx.workspace`; this function intentionally
 * exposes neither connection metadata nor any target/access mutation.
 */
export async function listWorkspaceExecutionTargets({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<WorkspaceExecutionTarget[]> {
  const callerExecutionTargetId = await findActingDeviceExecutionTargetId({ ctx });
  const rows = (await ctx.db.all(
    `SELECT et.id, et.type, et.label, et.status,
            owner_profile.display_name AS owner_display_name,
            d.last_seen_at AS device_last_seen_at,
            registration.health AS virtual_health,
            registration.last_heartbeat_at AS virtual_last_heartbeat_at,
            (SELECT COUNT(*)
               FROM workspace_user_execution_targets access_count
              WHERE access_count.workspace_id = et.workspace_id
                AND access_count.execution_target_id = et.id
                AND access_count.deleted_at IS NULL
                AND access_count.access_status = 'active') AS active_member_access_count,
            CASE WHEN EXISTS (
              SELECT 1
                FROM workspace_user_execution_targets current_access
               WHERE current_access.workspace_id = et.workspace_id
                 AND current_access.execution_target_id = et.id
                 AND current_access.workspace_user_id = ?
                 AND current_access.deleted_at IS NULL
                 AND current_access.access_status = 'active'
            ) THEN 1 ELSE 0 END AS has_current_user_access
       FROM execution_targets et
       LEFT JOIN workspace_users owner_member
         ON owner_member.id = et.owner_workspace_user_id
        AND owner_member.workspace_id = et.workspace_id
        AND owner_member.deleted_at IS NULL
       LEFT JOIN profiles owner_profile ON owner_profile.id = owner_member.profile_id
       LEFT JOIN devices d
         ON d.id = et.device_id
        AND d.workspace_id = et.workspace_id
        AND d.deleted_at IS NULL
       LEFT JOIN execution_target_registrations registration
         ON registration.execution_target_id = et.id
        AND registration.workspace_id = et.workspace_id
        AND registration.deleted_at IS NULL
      WHERE et.workspace_id = ? AND et.deleted_at IS NULL
        AND NOT (et.type = 'local' AND d.platform = 'browser')
      ORDER BY et.label ASC, et.created_at ASC`,
    [ctx.actorWorkspaceUserId, ctx.workspace.id]
  )) as Array<{
    id: string;
    type: string;
    label: string;
    status: string;
    owner_display_name: string | null;
    device_last_seen_at: string | null;
    virtual_health: string | null;
    virtual_last_heartbeat_at: string | null;
    active_member_access_count: number | string;
    has_current_user_access: number | boolean;
  }>;

  return rows.map(row => {
    const isCallerTarget = row.id === callerExecutionTargetId;
    const lastSeenAt =
      row.type === 'virtual' ? row.virtual_last_heartbeat_at : row.device_last_seen_at;
    const reachable =
      row.type === 'virtual'
        ? (row.virtual_health === 'healthy' || row.virtual_health === 'degraded') &&
          isTargetReachable({ lastSeenAt, isCallerDevice: false })
        : isTargetReachable({ lastSeenAt, isCallerDevice: isCallerTarget });
    return {
      id: row.id,
      type: row.type,
      label: row.label,
      status: row.status,
      ownerDisplayName: row.owner_display_name,
      reachable,
      lastSeenAt,
      activeMemberAccessCount: Number(row.active_member_access_count),
      hasCurrentUserAccess: Boolean(row.has_current_user_access)
    };
  });
}

async function resolveProjectId(ctx: ServiceContext, projectId: string): Promise<string> {
  const row = (await ctx.db.get(
    `SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [projectId, ctx.workspace.id]
  )) as { id: string } | undefined;
  if (!row) {
    throw new ServiceError('Project not found', 'not_found', 404);
  }
  return row.id;
}

/**
 * Targets the acting workspace user may select for a project: active access rows
 * joined with execution targets and device heartbeat, filtered to those that can
 * reach a primary resource on the target (or a target-agnostic primary).
 */
export async function listEligibleProjectExecutionTargets({
  ctx,
  projectId
}: {
  ctx: ServiceContext;
  projectId: string;
}): Promise<EligibleExecutionTarget[]> {
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  if (!ctx.actorWorkspaceUserId) return [];

  const callerExecutionTargetId = await findActingDeviceExecutionTargetId({ ctx });
  const rows = (await ctx.db.all(
    `SELECT et.id AS execution_target_id, et.type, et.label AS target_label,
              et.device_id, d.label AS device_label, d.fingerprint AS device_fingerprint,
              d.platform AS device_platform, d.last_seen_at
         FROM workspace_user_execution_targets wuet
         JOIN execution_targets et
           ON et.id = wuet.execution_target_id
          AND et.workspace_id = wuet.workspace_id
          AND et.deleted_at IS NULL
          AND et.status = 'active'
         LEFT JOIN devices d
           ON d.id = et.device_id
          AND d.workspace_id = et.workspace_id
          AND d.deleted_at IS NULL
        WHERE wuet.workspace_id = ?
          AND wuet.workspace_user_id = ?
          AND wuet.deleted_at IS NULL
          AND wuet.access_status = 'active'
        ORDER BY et.label ASC, et.created_at ASC`,
    [ctx.workspace.id, ctx.actorWorkspaceUserId]
  )) as Array<{
    execution_target_id: string;
    type: string;
    target_label: string;
    device_id: string | null;
    device_label: string | null;
    device_fingerprint: string | null;
    device_platform: string | null;
    last_seen_at: string | null;
  }>;

  const eligible: EligibleExecutionTarget[] = [];
  for (const row of rows) {
    if (isBrowserDevicePlatform(row.device_platform)) {
      continue;
    }
    if (
      !isCoLocatedBackend(ctx.db) &&
      row.device_fingerprint &&
      isBackendHostFingerprint(row.device_fingerprint)
    ) {
      continue;
    }
    const primary = await findPrimaryProjectResource({
      ctx,
      projectId: resolvedProjectId,
      executionTargetId: row.execution_target_id
    });
    if (!primary) continue;

    const isCallerDevice =
      callerExecutionTargetId !== null && row.execution_target_id === callerExecutionTargetId;
    const primaryResourceConnected = primary.status !== 'missing';
    eligible.push({
      executionTargetId: row.execution_target_id,
      type: row.type,
      label: row.target_label,
      deviceLabel: row.device_label,
      reachable: isTargetReachable({
        lastSeenAt: row.last_seen_at,
        isCallerDevice
      }),
      primaryResourceConnected
    });
  }

  return eligible;
}

export async function getProjectExecutionTargetSelection({
  ctx,
  projectId
}: {
  ctx: ServiceContext;
  projectId: string;
}): Promise<ProjectExecutionTargetSelection> {
  await resolveProjectId(ctx, projectId);
  const eligibleTargets = await listEligibleProjectExecutionTargets({ ctx, projectId });
  const row = await readPreferenceRow(ctx, projectId);
  const storedId = row ? readStoredExecutionTargetId(row.preferences) : null;
  const eligibleIds = new Set(eligibleTargets.map(t => t.executionTargetId));
  const storedSelection = storedId && eligibleIds.has(storedId) ? storedId : null;
  const selectedExecutionTargetId =
    storedSelection ??
    (eligibleTargets.length === 1 ? eligibleTargets[0]!.executionTargetId : null);

  return { selectedExecutionTargetId, eligibleTargets };
}

export async function updateProjectExecutionTargetSelection({
  ctx,
  projectId,
  executionTargetId
}: {
  ctx: ServiceContext;
  projectId: string;
  /** `null` clears the explicit selection (launch falls back to single-target or any-target). */
  executionTargetId: string | null;
}): Promise<ProjectExecutionTargetSelection> {
  const resolvedProjectId = await resolveProjectId(ctx, projectId);
  const actorId = requireActor(ctx);

  if (executionTargetId !== null) {
    const eligible = await listEligibleProjectExecutionTargets({
      ctx,
      projectId: resolvedProjectId
    });
    if (!eligible.some(t => t.executionTargetId === executionTargetId)) {
      throw new ServiceError(
        'Execution target is not eligible for this project',
        'execution_target_not_eligible',
        400
      );
    }
  }

  const row = await readPreferenceRow(ctx, resolvedProjectId);
  const now = nowIso();
  const nextPreferences = {
    ...(row?.preferences ?? {}),
    [PROJECT_EXECUTION_TARGET_PREFERENCE_KEY]: executionTargetId
  };

  if (row) {
    await ctx.db.run(
      `UPDATE project_user_preferences
          SET preferences_json = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?`,
      [JSON.stringify(nextPreferences), now, row.id]
    );
  } else {
    await ctx.db.run(
      `INSERT INTO project_user_preferences
           (id, workspace_id, project_id, workspace_user_id, preferences_json,
            created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        newId(),
        ctx.workspace.id,
        resolvedProjectId,
        actorId,
        JSON.stringify(nextPreferences),
        now,
        now
      ]
    );
  }

  return getProjectExecutionTargetSelection({ ctx, projectId: resolvedProjectId });
}

/**
 * Resolve the execution target id to stamp on a newly queued request (WS-C / R3).
 * Preference wins when eligible; otherwise a sole eligible target; otherwise null.
 */
export async function resolveProjectExecutionTargetForLaunch({
  ctx,
  projectId
}: {
  ctx: ServiceContext;
  projectId: string;
}): Promise<string | null> {
  const { selectedExecutionTargetId, eligibleTargets } = await getProjectExecutionTargetSelection({
    ctx,
    projectId
  });
  if (selectedExecutionTargetId) return selectedExecutionTargetId;
  if (eligibleTargets.length === 1) return eligibleTargets[0]!.executionTargetId;
  return null;
}

/**
 * Coerce a stored `agent_configs_json` blob into a map of per-agent launch
 * mechanics, dropping anything malformed. Shared by the core launch resolver
 * and the webapp launch surface so both decode the blob identically.
 */
export function parseAgentConfigs(json: string): Record<string, AgentLaunchConfig> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
  const configs: Record<string, AgentLaunchConfig> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue;
    const config = value as { preCommand?: unknown; flags?: unknown };
    configs[key] = {
      preCommand: typeof config.preCommand === 'string' ? config.preCommand : '',
      flags: normalizeAgentLaunchFlags(config.flags)
    };
  }
  return configs;
}

/** How the effective launch config was resolved, most specific first. */
export type LaunchConfigSource = 'objective' | 'user_target' | 'workspace' | 'none';

/**
 * Read the workspace catalog's launch default for one agent (the lowest-priority
 * launch-config source). Lives in `workspaces.settings_json.agentCatalog.agents
 * [agentKey].launchDefaults`; tolerates missing/malformed settings by returning null.
 */
async function readWorkspaceAgentLaunchDefault(
  ctx: ServiceContext,
  agentKey: string
): Promise<AgentLaunchConfig | null> {
  const row = (await ctx.db.get(
    `SELECT settings_json FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    [ctx.workspace.id]
  )) as { settings_json: string } | undefined;
  if (!row) return null;
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(row.settings_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const catalog = settings.agentCatalog as
    | { agents?: Record<string, { launchDefaults?: { preCommand?: unknown; flags?: unknown } }> }
    | undefined;
  const launchDefaults = catalog?.agents?.[agentKey]?.launchDefaults;
  if (!launchDefaults || typeof launchDefaults !== 'object') return null;
  return {
    preCommand: typeof launchDefaults.preCommand === 'string' ? launchDefaults.preCommand : '',
    flags: normalizeAgentLaunchFlags(launchDefaults.flags)
  };
}

/**
 * Resolve the effective launch config (pre-command + flags) for an objective +
 * target + agent, most specific source first (see "Launch Configuration
 * Resolution" in connectors/docs/agent-harness-configuration-architecture.md):
 *
 * 1. `objectives.launch_config_json[targetId][agentKey]` — authoritative when present
 * 2. The user's per-target config (`user_execution_target_preferences.agent_configs_json`)
 * 3. The workspace catalog's launch default for the agent
 * 4. Empty (no pre-command, no flags)
 *
 * Shared by the manual webapp launch path and the core auto-advance path so both
 * stamp the same `execution_requests.launch_flags_json`.
 */
export async function resolveLaunchConfig({
  ctx,
  objectiveLaunchConfigJson,
  executionTargetId,
  agentKey,
  userConfigs
}: {
  ctx: ServiceContext;
  objectiveLaunchConfigJson: string | null;
  executionTargetId: string | null;
  agentKey: string;
  userConfigs: Record<string, AgentLaunchConfig>;
}): Promise<{ config: AgentLaunchConfig; source: LaunchConfigSource }> {
  if (executionTargetId && objectiveLaunchConfigJson) {
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
            flags: normalizeAgentLaunchFlags(cast.flags)
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

  const workspaceDefault = await readWorkspaceAgentLaunchDefault(ctx, agentKey);
  if (workspaceDefault) {
    return { config: workspaceDefault, source: 'workspace' };
  }

  return { config: { preCommand: '', flags: [] }, source: 'none' };
}

export async function readAgentConfigsForExecutionTarget({
  ctx,
  executionTargetId
}: {
  ctx: ServiceContext;
  executionTargetId: string;
}): Promise<Record<string, AgentLaunchConfig>> {
  if (!ctx.actorWorkspaceUserId) return {};
  const row = (await ctx.db.get(
    `SELECT uetp.id AS preference_id
       FROM execution_targets et
       JOIN devices d
         ON d.id = et.device_id
        AND d.workspace_id = et.workspace_id
        AND d.deleted_at IS NULL
       JOIN workspace_users wu
         ON wu.id = ?
        AND wu.workspace_id = et.workspace_id
        AND wu.deleted_at IS NULL
       LEFT JOIN user_execution_target_preferences uetp
         ON uetp.profile_id = wu.profile_id
        AND uetp.target_type = et.type
        AND uetp.target_fingerprint = d.fingerprint
        AND uetp.deleted_at IS NULL
      WHERE et.id = ?
        AND et.workspace_id = ?
        AND et.deleted_at IS NULL`,
    [ctx.actorWorkspaceUserId, executionTargetId, ctx.workspace.id]
  )) as { preference_id: string | null } | undefined;
  if (!row?.preference_id) return {};
  const pref = (await ctx.db.get(
    `SELECT agent_configs_json FROM user_execution_target_preferences WHERE id = ?`,
    [row.preference_id]
  )) as { agent_configs_json: string } | undefined;
  return pref ? parseAgentConfigs(pref.agent_configs_json) : {};
}

/**
 * Resolve the execution target and per-agent launch configs for queueing a request.
 * Does not fall back to the caller device's target when selection is ambiguous (WS-B).
 */
export async function resolveLaunchExecutionTarget({
  ctx,
  projectId
}: {
  ctx: ServiceContext;
  projectId: string;
}): Promise<LaunchExecutionTargetResolution> {
  const executionTargetId = await resolveProjectExecutionTargetForLaunch({ ctx, projectId });
  const agentConfigs =
    executionTargetId === null
      ? {}
      : await readAgentConfigsForExecutionTarget({ ctx, executionTargetId });
  return { executionTargetId, agentConfigs };
}

const ACTIVE_QUEUE_STATUSES = ['queued', 'claimed', 'launching'] as const;

/**
 * Soft-delete a workspace execution target and detach dependent preferences/source links.
 * Does not hard-delete historical queue rows or observations.
 */
export async function deleteWorkspaceExecutionTarget({
  ctx,
  executionTargetId
}: {
  ctx: ServiceContext;
  executionTargetId: string;
}): Promise<void> {
  const id = executionTargetId.trim();
  if (!id) {
    throw new ServiceError('executionTargetId is required', 'validation_error', 400);
  }

  const target = (await ctx.db.get(
    `SELECT id FROM execution_targets
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [id, ctx.workspace.id]
  )) as { id: string } | undefined;
  if (!target) {
    throw new ServiceError('Execution target not found', 'not_found', 404);
  }

  const placeholders = ACTIVE_QUEUE_STATUSES.map(() => '?').join(', ');
  const activeQueue = (await ctx.db.get(
    `SELECT COUNT(*) AS count
       FROM execution_requests
      WHERE workspace_id = ?
        AND deleted_at IS NULL
        AND (execution_target_id = ? OR claimed_by_execution_target_id = ?)
        AND status IN (${placeholders})`,
    [ctx.workspace.id, id, id, ...ACTIVE_QUEUE_STATUSES]
  )) as { count: number | string } | undefined;
  if (Number(activeQueue?.count ?? 0) > 0) {
    throw new ServiceError(
      'Cannot delete an execution target with active queued work. Cancel or wait for runs to finish first.',
      'execution_target_has_active_queue',
      409
    );
  }

  const now = nowIso();

  await ctx.db.run(
    `UPDATE workspace_user_execution_targets
        SET deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE workspace_id = ? AND execution_target_id = ? AND deleted_at IS NULL`,
    [now, now, ctx.workspace.id, id]
  );

  await ctx.db.run(
    `UPDATE project_resource_sources
        SET deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE workspace_id = ? AND execution_target_id = ? AND deleted_at IS NULL`,
    [now, now, ctx.workspace.id, id]
  );

  const preferenceRows = (await ctx.db.all(
    `SELECT id, preferences_json FROM project_user_preferences
        WHERE workspace_id = ? AND deleted_at IS NULL`,
    [ctx.workspace.id]
  )) as Array<{ id: string; preferences_json: string }>;

  for (const row of preferenceRows) {
    let preferences: Record<string, unknown>;
    try {
      preferences = JSON.parse(row.preferences_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (preferences[PROJECT_EXECUTION_TARGET_PREFERENCE_KEY] !== id) continue;
    delete preferences[PROJECT_EXECUTION_TARGET_PREFERENCE_KEY];
    await ctx.db.run(
      `UPDATE project_user_preferences
          SET preferences_json = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?`,
      [JSON.stringify(preferences), now, row.id]
    );
  }

  await ctx.db.run(
    `UPDATE execution_targets
        SET deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [now, now, id, ctx.workspace.id]
  );

  await recordChange({
    ctx,
    entityType: 'execution_target',
    entityId: id,
    operation: 'delete',
    entityRevision: null,
    changedFields: ['deleted_at']
  });
}

/** Rename an execution target that belongs to the acting workspace. */
export async function renameWorkspaceExecutionTarget({
  ctx,
  executionTargetId,
  label
}: {
  ctx: ServiceContext;
  executionTargetId: string;
  label: string;
}): Promise<WorkspaceExecutionTarget> {
  const id = executionTargetId.trim();
  if (!id) {
    throw new ServiceError('executionTargetId is required', 'validation_error', 400);
  }

  const nextLabel = label.trim();
  if (!nextLabel) {
    throw new ServiceError('label is required', 'validation_error', 400);
  }

  const target = (await ctx.db.get(
    `SELECT id FROM execution_targets
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [id, ctx.workspace.id]
  )) as { id: string } | undefined;
  if (!target) {
    throw new ServiceError('Execution target not found', 'not_found', 404);
  }

  const now = nowIso();
  await ctx.db.run(
    `UPDATE execution_targets
        SET label = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [nextLabel, now, id, ctx.workspace.id]
  );

  await recordChange({
    ctx,
    entityType: 'execution_target',
    entityId: id,
    operation: 'update',
    entityRevision: null,
    changedFields: ['label']
  });

  const targets = await listWorkspaceExecutionTargets({ ctx });
  const updated = targets.find(entry => entry.id === id);
  if (!updated) {
    throw new ServiceError('Execution target not found', 'not_found', 404);
  }
  return updated;
}
