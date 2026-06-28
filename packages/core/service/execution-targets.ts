import { hostname } from 'node:os';

import {
  DEFAULT_TERMINAL_PROFILE,
  parseTerminalProfileJson,
  serializeTerminalProfile,
  type TerminalProfile
} from '../../../cli/src/terminal-profile-types.ts';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { callerDeviceFingerprint, getDevice } from './devices.js';
import { ServiceError } from './errors.js';
import { newId, nowIso } from './util.js';

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

/**
 * Read-only lookup of the local execution target for the process host fingerprint.
 * Does not provision devices, targets, or preferences — safe for list/read API paths.
 */
export async function findCallerDeviceExecutionTargetId({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<string | null> {
  const fingerprint = callerDeviceFingerprint();
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
export async function ensureCallerDeviceTarget({
  ctx
}: {
  ctx: ServiceContext;
}): Promise<LocalExecutionTarget> {
  const device = await getDevice({ ctx });
  const now = nowIso();

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

export async function updateTerminalProfile({
  ctx,
  profile
}: {
  ctx: ServiceContext;
  profile: TerminalProfile;
}): Promise<LocalExecutionTarget> {
  const target = await ensureCallerDeviceTarget({ ctx });
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
