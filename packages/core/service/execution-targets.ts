import { hostname, platform } from 'node:os';

import {
  DEFAULT_TERMINAL_PROFILE,
  parseTerminalProfileJson,
  serializeTerminalProfile,
  type TerminalProfile
} from '../../../cli/src/terminal-profile-types.ts';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import type { ClientDeviceIdentity } from './device-identity.js';
import { callerDeviceFingerprint } from './devices.js';
import { ServiceError } from './errors.js';
import { isCoLocatedBackend } from './local-target/index.js';
import { newId, nowIso } from './util.js';

export type { ClientDeviceIdentity } from './device-identity.js';

export type LocalExecutionTarget = {
  deviceId: string;
  deviceLabel: string;
  executionTargetId: string;
  targetFingerprint: string;
  userTargetId: string | null;
  preferenceId: string | null;
  terminalProfile: TerminalProfile;
};

function requireActor(ctx: ServiceContext): string {
  if (!ctx.actorWorkspaceUserId) {
    throw new ServiceError(
      'No active workspace user to store execution-target settings for',
      'no_actor',
      409
    );
  }
  return ctx.actorWorkspaceUserId;
}

async function actorProfileId(ctx: ServiceContext): Promise<string | null> {
  if (!ctx.actorWorkspaceUserId) return null;
  const row = (await ctx.db.get(
    `SELECT profile_id FROM workspace_users
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [ctx.actorWorkspaceUserId, ctx.workspace.id]
  )) as { profile_id: string } | undefined;
  return row?.profile_id ?? null;
}

async function ensureUserExecutionTargetPreference({
  ctx,
  profileId,
  targetType,
  targetFingerprint
}: {
  ctx: ServiceContext;
  profileId: string;
  targetType: string;
  targetFingerprint: string;
}): Promise<{ id: string; terminalProfile: TerminalProfile }> {
  const existing = (await ctx.db.get(
    `SELECT id, terminal_profile_json FROM user_execution_target_preferences
        WHERE profile_id = ? AND target_type = ? AND target_fingerprint = ?
          AND deleted_at IS NULL`,
    [profileId, targetType, targetFingerprint]
  )) as { id: string; terminal_profile_json: string } | undefined;

  if (existing) {
    return {
      id: existing.id,
      terminalProfile: parseTerminalProfileJson(existing.terminal_profile_json)
    };
  }

  const id = newId();
  const now = nowIso();
  const terminalProfile = { ...DEFAULT_TERMINAL_PROFILE };
  await ctx.db.run(
    `INSERT INTO user_execution_target_preferences
         (id, profile_id, target_type, target_fingerprint, agent_configs_json,
          terminal_profile_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, 1)`,
    [
      id,
      profileId,
      targetType,
      targetFingerprint,
      serializeTerminalProfile(terminalProfile),
      now,
      now
    ]
  );
  await recordChange({
    ctx,
    entityType: 'user_execution_target_preference',
    entityId: id,
    operation: 'insert',
    entityRevision: 1
  });

  return { id, terminalProfile };
}

/** Fingerprint of the hosted backend process host — never a client execution target. */
export function backendHostFingerprint(): string {
  return callerDeviceFingerprint();
}

export function isBackendHostFingerprint(fingerprint: string): boolean {
  return fingerprint.trim() === backendHostFingerprint();
}

function resolveClientDevice(ctx: ServiceContext): ClientDeviceIdentity | null {
  const fingerprint = ctx.clientDevice?.deviceFingerprint?.trim();
  if (!fingerprint) return null;
  return {
    deviceFingerprint: fingerprint,
    deviceLabel: ctx.clientDevice?.deviceLabel,
    devicePlatform: ctx.clientDevice?.devicePlatform
  };
}

async function findDeviceExecutionTargetIdForFingerprint({
  ctx,
  fingerprint
}: {
  ctx: ServiceContext;
  fingerprint: string;
}): Promise<string | null> {
  const row = (await ctx.db.get(
    `SELECT et.id AS execution_target_id
       FROM devices d
       JOIN execution_targets et
         ON et.device_id = d.id
        AND et.workspace_id = d.workspace_id
        AND et.type = 'local'
        AND et.deleted_at IS NULL
      WHERE d.workspace_id = ?
        AND d.fingerprint = ?
        AND d.deleted_at IS NULL`,
    [ctx.workspace.id, fingerprint]
  )) as { execution_target_id: string } | undefined;
  return row?.execution_target_id ?? null;
}

/**
 * Read-only lookup of the acting client's local execution target. On co-located
 * backends this is the process host; on hosted backends it uses `ctx.clientDevice`
 * and never the Railway/container host.
 */
export async function findActingDeviceExecutionTargetId({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<string | null> {
  if (isCoLocatedBackend(ctx.db)) {
    return findDeviceExecutionTargetIdForFingerprint({
      ctx,
      fingerprint: callerDeviceFingerprint()
    });
  }
  const client = resolveClientDevice(ctx);
  if (!client) return null;
  if (isBackendHostFingerprint(client.deviceFingerprint)) return null;
  return findDeviceExecutionTargetIdForFingerprint({
    ctx,
    fingerprint: client.deviceFingerprint
  });
}

/**
 * Read-only lookup of the local execution target for the process host fingerprint.
 * Does not provision devices, targets, or preferences — safe for list/read API paths.
 *
 * @deprecated On hosted backends this returns the backend host target, which must
 * never be used for client execution. Prefer {@link findActingDeviceExecutionTargetId}.
 */
export async function findCallerDeviceExecutionTargetId({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<string | null> {
  if (!isCoLocatedBackend(ctx.db)) return null;
  return findDeviceExecutionTargetIdForFingerprint({
    ctx,
    fingerprint: callerDeviceFingerprint()
  });
}

/**
 * Provision (and return) the execution target for **the device running this
 * service-layer call** — the calling process's own machine.
 *
 * This is the *caller/claiming* identity: the runner/CLI that polls
 * (`claimNextExecutionRequest`), the device whose terminal/agent launch
 * preferences apply, and the device a freshly-linked resource is scoped to. It
 * is derived from `getDevice(ctx)`, so in the Local edition (backend == laptop)
 * it is the user's machine.
 *
 * It MUST NOT be used to decide *where a queued request should run*: stamping a
 * created request with the creator's device is the §3.2 conflation that breaks
 * Cloud (the hosted backend would invent a target for the Railway host). Request
 * creation stamps the *selected* execution target instead (WS-C), or NULL =
 * "any eligible target may claim."
 */
async function ensureDeviceTargetForFingerprint({
  ctx,
  fingerprint,
  label,
  platformName
}: {
  ctx: ServiceContext;
  fingerprint: string;
  label: string;
  platformName: string | null;
}): Promise<LocalExecutionTarget> {
  const now = nowIso();

  let device = (await ctx.db.get(
    `SELECT id, label, fingerprint FROM devices
        WHERE workspace_id = ? AND fingerprint = ? AND deleted_at IS NULL`,
    [ctx.workspace.id, fingerprint]
  )) as { id: string; label: string; fingerprint: string } | undefined;

  if (device) {
    await ctx.db.run(
      `UPDATE devices SET last_seen_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
      [now, now, device.id]
    );
  } else {
    const id = newId();
    await ctx.db.run(
      `INSERT INTO devices
           (id, workspace_id, fingerprint, label, platform, status, last_seen_at,
            metadata_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, 'active', ?, '{}', ?, ?, 1)`,
      [id, ctx.workspace.id, fingerprint, label, platformName, now, now, now]
    );
    await recordChange({
      ctx,
      entityType: 'device',
      entityId: id,
      operation: 'insert',
      entityRevision: 1
    });
    device = { id, label, fingerprint };
  }

  let target = (await ctx.db.get(
    `SELECT id FROM execution_targets
        WHERE workspace_id = ? AND device_id = ? AND type = 'local' AND deleted_at IS NULL`,
    [ctx.workspace.id, device.id]
  )) as { id: string } | undefined;

  if (!target) {
    const id = newId();
    await ctx.db.run(
      `INSERT INTO execution_targets
           (id, workspace_id, device_id, owner_workspace_user_id, type, label, status,
            connection_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, 'local', ?, 'active', '{}', ?, ?, 1)`,
      [
        id,
        ctx.workspace.id,
        device.id,
        ctx.actorWorkspaceUserId,
        device.label || hostname(),
        now,
        now
      ]
    );
    await recordChange({
      ctx,
      entityType: 'execution_target',
      entityId: id,
      operation: 'insert',
      entityRevision: 1
    });
    target = { id };
  }

  let userTargetId: string | null = null;
  let preferenceId: string | null = null;
  let terminalProfile = { ...DEFAULT_TERMINAL_PROFILE };

  if (ctx.actorWorkspaceUserId) {
    const userTarget = (await ctx.db.get(
      `SELECT id FROM workspace_user_execution_targets
          WHERE workspace_id = ? AND workspace_user_id = ? AND execution_target_id = ?
            AND deleted_at IS NULL`,
      [ctx.workspace.id, ctx.actorWorkspaceUserId, target.id]
    )) as { id: string } | undefined;

    if (userTarget) {
      userTargetId = userTarget.id;
    } else {
      userTargetId = newId();
      await ctx.db.run(
        `INSERT INTO workspace_user_execution_targets
             (id, workspace_id, workspace_user_id, execution_target_id, access_status,
              created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
        [userTargetId, ctx.workspace.id, ctx.actorWorkspaceUserId, target.id, now, now]
      );
      await recordChange({
        ctx,
        entityType: 'workspace_user_execution_target',
        entityId: userTargetId,
        operation: 'insert',
        entityRevision: 1
      });
    }

    const profileId = await actorProfileId(ctx);
    if (profileId) {
      const preference = await ensureUserExecutionTargetPreference({
        ctx,
        profileId,
        targetType: 'local',
        targetFingerprint: device.fingerprint
      });
      preferenceId = preference.id;
      terminalProfile = preference.terminalProfile;
    }
  }

  return {
    deviceId: device.id,
    deviceLabel: device.label,
    executionTargetId: target.id,
    targetFingerprint: device.fingerprint,
    userTargetId,
    preferenceId,
    terminalProfile
  };
}

export async function ensureClientDeviceTarget({
  ctx,
  deviceFingerprint,
  deviceLabel,
  devicePlatform
}: {
  ctx: ServiceContext;
  deviceFingerprint: string;
  deviceLabel?: string | null;
  devicePlatform?: string | null;
}): Promise<LocalExecutionTarget> {
  const fingerprint = deviceFingerprint.trim();
  if (!fingerprint) {
    throw new ServiceError('deviceFingerprint is required', 'validation_error', 400);
  }
  return ensureDeviceTargetForFingerprint({
    ctx,
    fingerprint,
    label: deviceLabel?.trim() || hostname(),
    platformName: devicePlatform?.trim() || platform()
  });
}

/**
 * Resolve the execution target a runner claim should use. On the co-located Local
 * backend the service process host is the runner; on the hosted backend the CLI
 * must supply its machine fingerprint so claims match WS-C stamped targets.
 */
export async function resolveClaimingDeviceTarget({
  ctx,
  clientDevice
}: {
  ctx: ServiceContext;
  clientDevice?: ClientDeviceIdentity | null;
}): Promise<LocalExecutionTarget> {
  const mergedCtx: ServiceContext = {
    ...ctx,
    clientDevice: clientDevice ?? ctx.clientDevice ?? null
  };
  return ensureActingDeviceTarget({ ctx: mergedCtx });
}

/**
 * Provision the execution target for the acting client machine. Co-located Local
 * backends use the process host; hosted backends require `ctx.clientDevice` and
 * refuse to provision the backend host as a target.
 */
export async function ensureActingDeviceTarget({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<LocalExecutionTarget> {
  if (isCoLocatedBackend(ctx.db)) {
    return ensureDeviceTargetForFingerprint({
      ctx,
      fingerprint: callerDeviceFingerprint(),
      label: hostname(),
      platformName: platform()
    });
  }
  const client = resolveClientDevice(ctx);
  if (!client) {
    throw new ServiceError(
      'Client device identity is required on a hosted backend',
      'device_fingerprint_required',
      400
    );
  }
  if (isBackendHostFingerprint(client.deviceFingerprint)) {
    throw new ServiceError(
      'The hosted backend cannot act as a local execution target',
      'backend_not_execution_target',
      400
    );
  }
  return ensureClientDeviceTarget({
    ctx,
    deviceFingerprint: client.deviceFingerprint,
    deviceLabel: client.deviceLabel,
    devicePlatform: client.devicePlatform
  });
}

/**
 * Provision the execution target for the process host. Valid only on co-located
 * Local backends; hosted callers must use {@link ensureActingDeviceTarget}.
 */
export async function ensureCallerDeviceTarget({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<LocalExecutionTarget> {
  if (!isCoLocatedBackend(ctx.db)) {
    throw new ServiceError(
      'Caller device targets are only valid on a co-located local backend',
      'backend_not_execution_target',
      400
    );
  }
  return ensureDeviceTargetForFingerprint({
    ctx,
    fingerprint: callerDeviceFingerprint(),
    label: hostname(),
    platformName: platform()
  });
}

export async function updateTerminalProfile({
  ctx,
  profile
}: {
  ctx: ServiceContext;
  profile: TerminalProfile;
}): Promise<LocalExecutionTarget> {
  const target = await ensureActingDeviceTarget({ ctx });
  requireActor(ctx);
  if (!target.preferenceId) {
    throw new ServiceError(
      'No active profile to store execution-target settings for',
      'no_profile',
      409
    );
  }
  const serialized = serializeTerminalProfile(profile);

  await ctx.db.run(
    `UPDATE user_execution_target_preferences
          SET terminal_profile_json = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?`,
    [serialized, nowIso(), target.preferenceId]
  );

  await recordChange({
    ctx,
    entityType: 'user_execution_target_preference',
    entityId: target.preferenceId,
    operation: 'update',
    entityRevision: null,
    changedFields: ['terminal_profile_json']
  });

  return { ...target, terminalProfile: profile };
}
