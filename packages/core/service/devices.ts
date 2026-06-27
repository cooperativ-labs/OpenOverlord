import { createHash } from 'node:crypto';
import { hostname, platform } from 'node:os';

import { recordChange } from './change-feed.js';
import type { ServiceContext } from './context.js';
import { newId, nowIso } from './util.js';

function deviceFingerprint(): string {
  return createHash('sha256').update(`${hostname()}:${platform()}`).digest('hex').slice(0, 32);
}

export async function getDevice({ ctx }: { ctx: ServiceContext }): Promise<{
  id: string;
  label: string;
  fingerprint: string;
  platform: string | null;
}> {
  const fingerprint = deviceFingerprint();
  const existing = (await ctx.db.get(
    `SELECT id, label, fingerprint, platform FROM devices
       WHERE workspace_id = ? AND fingerprint = ? AND deleted_at IS NULL`,
    [ctx.workspace.id, fingerprint]
  )) as { id: string; label: string; fingerprint: string; platform: string | null } | undefined;

  if (existing) {
    await ctx.db.run(
      `UPDATE devices SET last_seen_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
      [nowIso(), nowIso(), existing.id]
    );
    return existing;
  }

  const now = nowIso();
  const id = newId();
  const label = hostname();

  await ctx.db.run(
    `INSERT INTO devices
         (id, workspace_id, fingerprint, label, platform, status, last_seen_at,
          metadata_json, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, 'active', ?, '{}', ?, ?, 1)`,
    [id, ctx.workspace.id, fingerprint, label, platform(), now, now, now]
  );

  await recordChange({
    ctx,
    entityType: 'device',
    entityId: id,
    operation: 'insert',
    entityRevision: 1
  });

  return { id, label, fingerprint, platform: platform() };
}

export async function updateDevice({
  ctx,
  deviceId,
  label
}: {
  ctx: ServiceContext;
  deviceId: string;
  label: string;
}): Promise<{ id: string; label: string }> {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new Error('Device label is required');
  }

  const now = nowIso();
  await ctx.db.run(
    `UPDATE devices SET label = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
    [trimmed, now, deviceId, ctx.workspace.id]
  );

  return { id: deviceId, label: trimmed };
}
