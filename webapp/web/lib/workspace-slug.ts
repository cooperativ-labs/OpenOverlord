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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 48);
}
