/**
 * Agent launch flags — name/value pairs that map to argv tokens when spawning an
 * agent harness. Many agents now use positional values (`--permission-mode auto`)
 * instead of standalone boolean flags (`--enable-auto-mode`).
 */

export type AgentLaunchFlagDto = {
  /** CLI flag token, usually starting with `--` (e.g. `--permission-mode`). */
  name: string;
  /** Positional value passed after the flag name; omit or null for boolean flags. */
  value?: string | null;
};

/**
 * Parse a single user-entered flag string into a structured flag. Accepts:
 * - `--verbose`
 * - `--permission-mode auto`
 * - `--permission-mode=auto`
 */
export function parseAgentLaunchFlagText(text: string): AgentLaunchFlagDto | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const eqIndex = trimmed.indexOf('=');
  if (eqIndex > 0 && trimmed.startsWith('--')) {
    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    return name ? { name, value: value.length > 0 ? value : null } : null;
  }

  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex > 0 && trimmed.startsWith('--')) {
    const name = trimmed.slice(0, spaceIndex).trim();
    const value = trimmed.slice(spaceIndex + 1).trim();
    return name ? { name, value: value.length > 0 ? value : null } : null;
  }

  return { name: trimmed };
}

/**
 * Coerce stored launch flags from legacy `string[]` or structured objects into
 * the canonical name/value representation.
 */
export function normalizeAgentLaunchFlags(input: unknown): AgentLaunchFlagDto[] {
  if (!Array.isArray(input)) return [];

  const flags: AgentLaunchFlagDto[] = [];
  for (const item of input) {
    if (typeof item === 'string') {
      const parsed = parseAgentLaunchFlagText(item);
      if (parsed) flags.push(parsed);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const record = item as { name?: unknown; value?: unknown };
    if (typeof record.name !== 'string') continue;
    const name = record.name.trim();
    if (!name) continue;
    const value =
      typeof record.value === 'string' ? record.value.trim() || null : null;
    flags.push({ name, value });
  }
  return flags;
}

/** Flatten structured flags into argv tokens for agent spawn. */
export function agentLaunchFlagsToArgv(flags: AgentLaunchFlagDto[]): string[] {
  const argv: string[] = [];
  for (const flag of flags) {
    const name = flag.name.trim();
    if (!name) continue;
    argv.push(name);
    const value = flag.value?.trim();
    if (value) {
      argv.push(value);
    }
  }
  return argv;
}

/** Stable key for React list identity across name/value pairs. */
export function agentLaunchFlagKey(flag: AgentLaunchFlagDto): string {
  const value = flag.value?.trim();
  return value ? `${flag.name.trim()}\u0000${value}` : flag.name.trim();
}

/** Human-readable flag text for display and search (e.g. `--permission-mode auto`). */
export function formatAgentLaunchFlagText(flag: AgentLaunchFlagDto): string {
  const name = flag.name.trim();
  const value = flag.value?.trim();
  return value ? `${name} ${value}` : name;
}
