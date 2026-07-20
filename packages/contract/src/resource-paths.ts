/**
 * `OVERLORD_PROJECT_RESOURCES_PATHS` encoding: comma-separated absolute paths
 * with an explicit `:rw` or `:ro` permission suffix on every entry.
 *
 * Format rules (coo:368):
 * - Separator: comma
 * - Permission suffix: `:rw` (read & write) or `:ro` (read-only reference)
 * - No suffix on input defaults to `rw` when parsing
 * - Whitespace around entries is tolerated when parsing
 */

export type ResourcePathPermission = 'rw' | 'ro';

export type ParsedResourcePathEntry = {
  path: string;
  permission: ResourcePathPermission;
};

const PERMISSION_SUFFIX_PATTERN = /:(rw|ro)$/;

export function accessModeToResourcePathPermission({
  accessMode,
  isPrimary = false
}: {
  accessMode?: string | null | undefined;
  isPrimary?: boolean;
}): ResourcePathPermission {
  if (isPrimary) return 'rw';
  return accessMode === 'read' ? 'ro' : 'rw';
}

export function formatResourcePathWithPermission({
  path,
  accessMode,
  isPrimary = false
}: {
  path: string;
  accessMode?: string | null | undefined;
  isPrimary?: boolean;
}): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  const permission = accessModeToResourcePathPermission({ accessMode, isPrimary });
  return `${trimmed}:${permission}`;
}

/** Parse one path entry, stripping a trailing `:rw`/`:ro` suffix when present. */
export function parseResourcePathEntry(entry: string): ParsedResourcePathEntry | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const match = trimmed.match(PERMISSION_SUFFIX_PATTERN);
  if (!match) {
    return { path: trimmed, permission: 'rw' };
  }
  const suffix = match[1] as ResourcePathPermission;
  return {
    path: trimmed.slice(0, -(suffix.length + 1)),
    permission: suffix
  };
}

/** Parse a comma-separated `OVERLORD_PROJECT_RESOURCES_PATHS` value. */
export function parseResourcePathsCsv(value: string): ParsedResourcePathEntry[] {
  if (!value.trim()) return [];
  return value
    .split(',')
    .map(entry => parseResourcePathEntry(entry))
    .filter((entry): entry is ParsedResourcePathEntry => entry !== null);
}

/**
 * Build the comma-separated path list from a project-resource manifest array.
 * Entries without a local path are omitted; every emitted path carries an
 * explicit `:rw` or `:ro` suffix derived from `accessMode` (primary → `rw`).
 */
export function formatProjectResourcePathsFromManifest(
  projectResources?: unknown[] | null
): string {
  if (!Array.isArray(projectResources)) return '';
  const paths: string[] = [];
  for (const entry of projectResources) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as {
      path?: unknown;
      accessMode?: unknown;
      isPrimary?: unknown;
    };
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    if (!path) continue;
    paths.push(
      formatResourcePathWithPermission({
        path,
        accessMode: typeof record.accessMode === 'string' ? record.accessMode : null,
        isPrimary: record.isPrimary === true
      })
    );
  }
  return paths.join(',');
}
