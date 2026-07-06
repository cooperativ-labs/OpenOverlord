import type { DatabaseClient } from '@overlord/database';

import { loadConfig } from '../cli/src/config.ts';

import { nowIso, requireDatabaseClient, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';

export const SQL_STUDIO_SETTINGS_KEY = 'sqlStudioEnabled';

function parseSettings(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function readSettingsJson(workspaceId: string, client: DatabaseClient): Promise<string> {
  const row = await client.get<{ settings_json: string }>(
    `SELECT settings_json FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    [workspaceId]
  );
  if (!row) throw new ApiError(404, 'Workspace not found');
  return row.settings_json;
}

/** Set (or delete, when `value === undefined`) one key in a workspace's `settings_json`. */
async function writeWorkspaceSetting({
  workspaceId,
  key,
  value,
  client
}: {
  workspaceId: string;
  key: string;
  value: unknown;
  client: DatabaseClient;
}): Promise<void> {
  const settings = parseSettings(await readSettingsJson(workspaceId, client));
  if (value === undefined) {
    delete settings[key];
  } else {
    settings[key] = value;
  }
  await client.run(
    `UPDATE workspaces
        SET settings_json = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND deleted_at IS NULL`,
    [JSON.stringify(settings), nowIso(), workspaceId]
  );
}

/**
 * Pure projections from a raw `settings_json` string, shared with
 * `listWorkspaces` so building workspace DTOs needs no per-workspace
 * settings queries. Each applies the same defaults as its `read*` wrapper.
 */
export function sqlStudioEnabledFromSettingsJson(raw: string): boolean {
  const value = parseSettings(raw)[SQL_STUDIO_SETTINGS_KEY];
  return typeof value === 'boolean' ? value : loadConfig().sqlStudioEnabled;
}

export async function readSqlStudioEnabled({
  workspaceId = WORKSPACE.id,
  client = requireDatabaseClient()
}: {
  workspaceId?: string;
  client?: DatabaseClient;
} = {}): Promise<boolean> {
  return sqlStudioEnabledFromSettingsJson(await readSettingsJson(workspaceId, client));
}

export async function writeSqlStudioEnabled({
  workspaceId,
  enabled,
  client = requireDatabaseClient()
}: {
  workspaceId: string;
  enabled: boolean;
  client?: DatabaseClient;
}): Promise<void> {
  await writeWorkspaceSetting({
    workspaceId,
    key: SQL_STUDIO_SETTINGS_KEY,
    value: enabled,
    client
  });
}
