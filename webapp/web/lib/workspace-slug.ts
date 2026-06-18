function normalizeWorkspaceIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Full workspace name, normalized for use as the stable workspace ID. */
export function suggestWorkspaceId(name: string): string {
  const normalized = normalizeWorkspaceIdentifier(name.replace(/\s+/g, '-'));
  return normalized.length > 0 ? normalized : 'workspace';
}

/** Keep manually typed workspace IDs in the same shape the server stores. */
export function sanitizeWorkspaceIdInput(value: string): string {
  return normalizeWorkspaceIdentifier(value);
}

/** First three letters of the workspace name, as the suggested slug. */
export function suggestWorkspaceSlug(name: string): string {
  const letters = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 3);
  return letters.length > 0 ? letters : 'workspace';
}

/** Keep manually typed slugs in the same shape the server stores (`slugify`). */
export function sanitizeWorkspaceSlugInput(value: string): string {
  return normalizeWorkspaceIdentifier(value);
}
