import { hostname } from 'node:os';

import {
  EMPTY_TERMINAL_PROFILE,
  parseTerminalProfileJson,
  serializeTerminalProfile,
  type TerminalProfile
} from '../../cli/src/terminal-profile-types.ts';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { getDevice } from './devices.js';
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

function actorProfileId(ctx: ServiceContext): string | null {
  if (!ctx.actorWorkspaceUserId) return null;
  const row = ctx.db
    .prepare(
      `SELECT profile_id FROM workspace_users
        WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`
    )
    .get(ctx.actorWorkspaceUserId, ctx.workspace.id) as { profile_id: string } | undefined;
  return row?.profile_id ?? null;
}

function ensureUserExecutionTargetPreference({
  ctx,
  profileId,
  targetType,
  targetFingerprint
}: {
  ctx: ServiceContext;
  profileId: string;
  targetType: string;
  targetFingerprint: string;
}): { id: string; terminalProfile: TerminalProfile } {
  const existing = ctx.db
    .prepare(
      `SELECT id, terminal_profile_json FROM user_execution_target_preferences
        WHERE profile_id = ? AND target_type = ? AND target_fingerprint = ?
          AND deleted_at IS NULL`
    )
    .get(profileId, targetType, targetFingerprint) as
    | { id: string; terminal_profile_json: string }
    | undefined;

  if (existing) {
    return {
      id: existing.id,
      terminalProfile: parseTerminalProfileJson(existing.terminal_profile_json)
    };
  }

  const id = newId();
  const now = nowIso();
  ctx.db
    .prepare(
      `INSERT INTO user_execution_target_preferences
         (id, profile_id, target_type, target_fingerprint, agent_configs_json,
          terminal_profile_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, '{}', '{}', ?, ?, 1)`
    )
    .run(id, profileId, targetType, targetFingerprint, now, now);
  recordChange({
    ctx,
    entityType: 'user_execution_target_preference',
    entityId: id,
    operation: 'insert',
    entityRevision: 1
  });

  return { id, terminalProfile: { ...EMPTY_TERMINAL_PROFILE } };
}

/** Provision the local device, execution target, and user-target row for this machine. */
export function ensureLocalExecutionTarget({ ctx }: { ctx: ServiceContext }): LocalExecutionTarget {
  const device = getDevice({ ctx });
  const now = nowIso();

  let target = ctx.db
    .prepare(
      `SELECT id FROM execution_targets
        WHERE workspace_id = ? AND device_id = ? AND type = 'local' AND deleted_at IS NULL`
    )
    .get(ctx.workspace.id, device.id) as { id: string } | undefined;

  if (!target) {
    const id = newId();
    ctx.db
      .prepare(
        `INSERT INTO execution_targets
           (id, workspace_id, device_id, owner_workspace_user_id, type, label, status,
            connection_json, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, 'local', ?, 'active', '{}', ?, ?, 1)`
      )
      .run(
        id,
        ctx.workspace.id,
        device.id,
        ctx.actorWorkspaceUserId,
        device.label || hostname(),
        now,
        now
      );
    recordChange({
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
  let terminalProfile = { ...EMPTY_TERMINAL_PROFILE };

  if (ctx.actorWorkspaceUserId) {
    const userTarget = ctx.db
      .prepare(
        `SELECT id FROM workspace_user_execution_targets
          WHERE workspace_id = ? AND workspace_user_id = ? AND execution_target_id = ?
            AND deleted_at IS NULL`
      )
      .get(ctx.workspace.id, ctx.actorWorkspaceUserId, target.id) as { id: string } | undefined;

    if (userTarget) {
      userTargetId = userTarget.id;
    } else {
      userTargetId = newId();
      ctx.db
        .prepare(
          `INSERT INTO workspace_user_execution_targets
             (id, workspace_id, workspace_user_id, execution_target_id, access_status,
              created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`
        )
        .run(userTargetId, ctx.workspace.id, ctx.actorWorkspaceUserId, target.id, now, now);
      recordChange({
        ctx,
        entityType: 'workspace_user_execution_target',
        entityId: userTargetId,
        operation: 'insert',
        entityRevision: 1
      });
    }

    const profileId = actorProfileId(ctx);
    if (profileId) {
      const preference = ensureUserExecutionTargetPreference({
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

export function updateTerminalProfile({
  ctx,
  profile
}: {
  ctx: ServiceContext;
  profile: TerminalProfile;
}): LocalExecutionTarget {
  const target = ensureLocalExecutionTarget({ ctx });
  requireActor(ctx);
  if (!target.preferenceId) {
    throw new ServiceError(
      'No active profile to store execution-target settings for',
      'no_profile',
      409
    );
  }
  const serialized = serializeTerminalProfile(profile);

  ctx.db
    .prepare(
      `UPDATE user_execution_target_preferences
          SET terminal_profile_json = ?, updated_at = ?, revision = revision + 1
        WHERE id = ?`
    )
    .run(serialized, nowIso(), target.preferenceId);

  recordChange({
    ctx,
    entityType: 'user_execution_target_preference',
    entityId: target.preferenceId,
    operation: 'update',
    entityRevision: null,
    changedFields: ['terminal_profile_json']
  });

  return { ...target, terminalProfile: profile };
}
