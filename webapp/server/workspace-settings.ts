import { loadConfig } from '../../cli/src/config.ts';

import { db, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';

export const SQL_STUDIO_SETTINGS_KEY = 'sqlStudioEnabled';
export const EVERHOUR_API_KEY_SETTINGS_KEY = 'everhourApiKey';

function parseSettings(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readWorkspaceSettingsRow(workspaceId: string): {
  settings_json: string;
  revision: number;
} {
  const row = db
    .prepare(`SELECT settings_json, revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
    .get(workspaceId) as { settings_json: string; revision: number } | undefined;
  if (!row) throw new ApiError(404, 'Workspace not found');
  return row;
}

export function readSqlStudioEnabled({
  workspaceId = WORKSPACE.id
}: {
  workspaceId?: string;
} = {}): boolean {
  const row = readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  if (typeof settings[SQL_STUDIO_SETTINGS_KEY] === 'boolean') {
    return settings[SQL_STUDIO_SETTINGS_KEY];
  }
  return loadConfig().sqlStudioEnabled;
}

export function writeSqlStudioEnabled({
  workspaceId,
  enabled
}: {
  workspaceId: string;
  enabled: boolean;
}): void {
  const row = readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  settings[SQL_STUDIO_SETTINGS_KEY] = enabled;
  const revision = row.revision + 1;
  db.prepare(
    `UPDATE workspaces
        SET settings_json = @settings_json, updated_at = @now, revision = @revision
      WHERE id = @id`
  ).run({
    id: workspaceId,
    settings_json: JSON.stringify(settings),
    now: new Date().toISOString(),
    revision
  });
}

/**
 * The workspace Everhour API key, or `null` when not configured. The key is held
 * server-side only and never returned to the client — the REST API Layer proxies
 * every Everhour call so the browser never sees it.
 */
export function readEverhourApiKey({
  workspaceId = WORKSPACE.id
}: {
  workspaceId?: string;
} = {}): string | null {
  const row = readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  const value = settings[EVERHOUR_API_KEY_SETTINGS_KEY];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Set or clear (pass `null`/empty) the workspace Everhour API key. */
export function writeEverhourApiKey({
  workspaceId = WORKSPACE.id,
  apiKey
}: {
  workspaceId?: string;
  apiKey: string | null;
}): void {
  const row = readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  const trimmed = apiKey?.trim();
  if (trimmed) {
    settings[EVERHOUR_API_KEY_SETTINGS_KEY] = trimmed;
  } else {
    delete settings[EVERHOUR_API_KEY_SETTINGS_KEY];
  }
  const revision = row.revision + 1;
  db.prepare(
    `UPDATE workspaces
        SET settings_json = @settings_json, updated_at = @now, revision = @revision
      WHERE id = @id`
  ).run({
    id: workspaceId,
    settings_json: JSON.stringify(settings),
    now: new Date().toISOString(),
    revision
  });
}
