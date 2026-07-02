import { loadConfig } from '../cli/src/config.ts';

import { nowIso, requireDatabaseClient, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';

export const SQL_STUDIO_SETTINGS_KEY = 'sqlStudioEnabled';
export const EVERHOUR_API_KEY_SETTINGS_KEY = 'everhourApiKey';
export const LOGO_URL_SETTINGS_KEY = 'logoUrl';

function parseSettings(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function readWorkspaceSettingsRow(workspaceId: string): Promise<{
  settings_json: string;
  revision: number;
}> {
  const row = await requireDatabaseClient().get<{ settings_json: string; revision: number }>(
    `SELECT settings_json, revision FROM workspaces WHERE id = ? AND deleted_at IS NULL`,
    [workspaceId]
  );
  if (!row) throw new ApiError(404, 'Workspace not found');
  return row;
}

export async function readSqlStudioEnabled({
  workspaceId = WORKSPACE.id
}: {
  workspaceId?: string;
} = {}): Promise<boolean> {
  const row = await readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  if (typeof settings[SQL_STUDIO_SETTINGS_KEY] === 'boolean') {
    return settings[SQL_STUDIO_SETTINGS_KEY];
  }
  return loadConfig().sqlStudioEnabled;
}

export async function writeSqlStudioEnabled({
  workspaceId,
  enabled
}: {
  workspaceId: string;
  enabled: boolean;
}): Promise<void> {
  const row = await readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  settings[SQL_STUDIO_SETTINGS_KEY] = enabled;
  const revision = row.revision + 1;
  const now = nowIso();
  await requireDatabaseClient().run(
    `UPDATE workspaces
        SET settings_json = ?, updated_at = ?, revision = ?
      WHERE id = ?`,
    [JSON.stringify(settings), now, revision, workspaceId]
  );
}

/** The workspace's logo image URL, or `null` when not set. */
export async function readWorkspaceLogoUrl({
  workspaceId = WORKSPACE.id
}: {
  workspaceId?: string;
} = {}): Promise<string | null> {
  const row = await readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  const value = settings[LOGO_URL_SETTINGS_KEY];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Set or clear (pass `null`/empty) the workspace logo image URL. */
export async function writeWorkspaceLogoUrl({
  workspaceId,
  logoUrl
}: {
  workspaceId: string;
  logoUrl: string | null;
}): Promise<void> {
  const row = await readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  const trimmed = logoUrl?.trim();
  if (trimmed) {
    settings[LOGO_URL_SETTINGS_KEY] = trimmed;
  } else {
    delete settings[LOGO_URL_SETTINGS_KEY];
  }
  const revision = row.revision + 1;
  const now = nowIso();
  await requireDatabaseClient().run(
    `UPDATE workspaces
        SET settings_json = ?, updated_at = ?, revision = ?
      WHERE id = ?`,
    [JSON.stringify(settings), now, revision, workspaceId]
  );
}

/**
 * The workspace Everhour API key, or `null` when not configured. The key is held
 * server-side only and never returned to the client — the REST API Layer proxies
 * every Everhour call so the browser never sees it.
 */
export async function readEverhourApiKey({
  workspaceId = WORKSPACE.id
}: {
  workspaceId?: string;
} = {}): Promise<string | null> {
  const row = await readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  const value = settings[EVERHOUR_API_KEY_SETTINGS_KEY];
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Set or clear (pass `null`/empty) the workspace Everhour API key. */
export async function writeEverhourApiKey({
  workspaceId = WORKSPACE.id,
  apiKey
}: {
  workspaceId?: string;
  apiKey: string | null;
}): Promise<void> {
  const row = await readWorkspaceSettingsRow(workspaceId);
  const settings = parseSettings(row.settings_json);
  const trimmed = apiKey?.trim();
  if (trimmed) {
    settings[EVERHOUR_API_KEY_SETTINGS_KEY] = trimmed;
  } else {
    delete settings[EVERHOUR_API_KEY_SETTINGS_KEY];
  }
  const revision = row.revision + 1;
  const now = nowIso();
  await requireDatabaseClient().run(
    `UPDATE workspaces
        SET settings_json = ?, updated_at = ?, revision = ?
      WHERE id = ?`,
    [JSON.stringify(settings), now, revision, workspaceId]
  );
}
