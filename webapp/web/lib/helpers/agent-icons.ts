/** Brand icon metadata for an agent connector. */
export interface AgentIconMeta {
  /** Public asset path served from `webapp/public`. */
  src: string;
  /** Whether the icon should be inverted in dark mode (monochrome marks). */
  invertDark: boolean;
}

/**
 * Maps connector agent keys (see `cli/src/agent-catalog-defaults.ts` and the
 * workspace catalog) to their brand icon. Centralizes the easy-to-forget
 * `invertDark` dark-mode rule so call sites don't copy it inline.
 */
const AGENT_ICONS: Record<string, AgentIconMeta> = {
  claude: { src: '/images/icons/claude-code.svg', invertDark: false },
  codex: { src: '/images/icons/codex.svg', invertDark: true },
  cursor: { src: '/images/icons/cursor.svg', invertDark: true },
  opencode: { src: '/images/icons/opencode.svg', invertDark: false },
  antigravity: { src: '/images/icons/antigravity.svg', invertDark: false },
  pi: { src: '/images/icons/pi.svg', invertDark: true },
  gemini: { src: '/images/icons/gemini.svg', invertDark: false }
};

/** Resolve an agent's icon metadata by connector key. Returns null when unmapped. */
export function getAgentIcon(key: string | null | undefined): AgentIconMeta | null {
  if (!key) return null;
  return AGENT_ICONS[key] ?? null;
}
