import {
  agentLaunchFlagKey,
  formatAgentLaunchFlagText,
  type AgentLaunchFlagDto
} from '../../shared/contract.ts';

const RECENT_AGENT_LAUNCH_FLAGS_STORAGE_PREFIX = 'overlord:recent-agent-launch-flags';
const MAX_RECENT_FLAGS_PER_AGENT = 3;

type RecentFlagsByAgent = Record<string, AgentLaunchFlagDto[]>;

function storageKey(): string | null {
  if (typeof window === 'undefined') return null;
  const backendKey = window.localStorage.getItem('overlord:active-backend-key');
  if (!backendKey) return null;
  return `${RECENT_AGENT_LAUNCH_FLAGS_STORAGE_PREFIX}:${backendKey}`;
}

function readAllRecentFlags(): RecentFlagsByAgent {
  const key = storageKey();
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const result: RecentFlagsByAgent = {};
    for (const [agentKey, flags] of Object.entries(parsed)) {
      if (!Array.isArray(flags)) continue;
      const normalized: AgentLaunchFlagDto[] = [];
      for (const item of flags) {
        if (!item || typeof item !== 'object') continue;
        const record = item as { name?: unknown; value?: unknown };
        if (typeof record.name !== 'string') continue;
        const name = record.name.trim();
        if (!name) continue;
        const value =
          typeof record.value === 'string' ? record.value.trim() || null : null;
        normalized.push({ name, value });
      }
      if (normalized.length > 0) {
        result[agentKey] = normalized.slice(0, MAX_RECENT_FLAGS_PER_AGENT);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeAllRecentFlags(flagsByAgent: RecentFlagsByAgent): void {
  const key = storageKey();
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(flagsByAgent));
  } catch {
    /* localStorage may be unavailable */
  }
}

/** Read the last few flags the user added for one agent on this device. */
export function readRecentAgentLaunchFlags(agentKey: string): AgentLaunchFlagDto[] {
  if (!agentKey.trim()) return [];
  return readAllRecentFlags()[agentKey] ?? [];
}

/** Remember a flag the user added, keeping the three most recent unique entries. */
export function recordRecentAgentLaunchFlag({
  agentKey,
  flag
}: {
  agentKey: string;
  flag: AgentLaunchFlagDto;
}): void {
  const trimmedAgentKey = agentKey.trim();
  const name = flag.name.trim();
  if (!trimmedAgentKey || !name) return;

  const normalized: AgentLaunchFlagDto = {
    name,
    value: flag.value?.trim() ? flag.value.trim() : null
  };
  const key = agentLaunchFlagKey(normalized);
  const all = readAllRecentFlags();
  const existing = (all[trimmedAgentKey] ?? []).filter(
    item => agentLaunchFlagKey(item) !== key
  );
  all[trimmedAgentKey] = [normalized, ...existing].slice(0, MAX_RECENT_FLAGS_PER_AGENT);
  writeAllRecentFlags(all);
}

/** Filter recent flags by the current draft search text. */
export function filterRecentAgentLaunchFlags({
  flags,
  query
}: {
  flags: AgentLaunchFlagDto[];
  query: string;
}): AgentLaunchFlagDto[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return flags;
  return flags.filter(flag => formatAgentLaunchFlagText(flag).toLowerCase().includes(trimmed));
}
