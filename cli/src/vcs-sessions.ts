import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveGlobalDataDir } from './config.js';

/**
 * Per-cwd active-session manifest.
 *
 * The Claude PostToolUse edit hook used to require `MISSION_ID` in the process
 * environment to know which mission's touched-files log to append to. Agent-pod
 * sessions never set that variable, so the hook was silently inert (see
 * planning/feature-plans/agent-change-attribution-optimization.md, Layer 1).
 *
 * Instead, `attach`/`resume-follow-up` record an entry here — keyed by the
 * working directory alone, since the hook only ever knows its own `cwd` — so the
 * hook (or any adapter) can resolve "which mission is active in this directory
 * right now" without needing the launching process to have exported anything.
 * `MISSION_ID` remains a valid override for callers that do set it explicitly.
 *
 * Entries are pruned on `deliver` (the session that owns them ends) and on read
 * (anything past `ACTIVE_SESSION_TTL_MS` is dropped as stale/abandoned).
 */

export type ActiveSessionEntry = {
  missionId: string;
  sessionKey: string;
  attachedAt: string;
};

const ACTIVE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function manifestPath(workingDirectory: string): string {
  const key = createHash('sha256').update(path.resolve(workingDirectory)).digest('hex');
  return path.join(resolveGlobalDataDir(), 'vcs-sessions', `${key}.json`);
}

function readEntries(workingDirectory: string): ActiveSessionEntry[] {
  try {
    const target = manifestPath(workingDirectory);
    if (!existsSync(target)) return [];
    const raw = JSON.parse(readFileSync(target, 'utf8')) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) return [];
    const now = Date.now();
    return raw.entries.flatMap(entry => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as ActiveSessionEntry).missionId !== 'string' ||
        typeof (entry as ActiveSessionEntry).sessionKey !== 'string' ||
        typeof (entry as ActiveSessionEntry).attachedAt !== 'string'
      ) {
        return [];
      }
      const candidate = entry as ActiveSessionEntry;
      const attachedAtMs = Date.parse(candidate.attachedAt);
      if (Number.isNaN(attachedAtMs) || now - attachedAtMs > ACTIVE_SESSION_TTL_MS) return [];
      return [candidate];
    });
  } catch {
    return [];
  }
}

function writeEntries(workingDirectory: string, entries: ActiveSessionEntry[]): void {
  try {
    const target = manifestPath(workingDirectory);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ entries }));
  } catch {
    // Best-effort: without a manifest entry, hooks fall back to the MISSION_ID
    // env var (or stay inert), same as before this feature existed.
  }
}

/** Record (or refresh) this session as active for its working directory. */
export function writeActiveSession({
  workingDirectory,
  missionId,
  sessionKey
}: {
  workingDirectory: string;
  missionId: string;
  sessionKey: string;
}): void {
  const trimmedMission = missionId.trim();
  const trimmedKey = sessionKey.trim();
  if (!trimmedMission || !trimmedKey) return;
  const entries = readEntries(workingDirectory).filter(entry => entry.missionId !== trimmedMission);
  entries.push({
    missionId: trimmedMission,
    sessionKey: trimmedKey,
    attachedAt: new Date().toISOString()
  });
  writeEntries(workingDirectory, entries);
}

/** Drop this mission's entry once its session ends (deliver). */
export function removeActiveSession({
  workingDirectory,
  missionId
}: {
  workingDirectory: string;
  missionId: string;
}): void {
  const remaining = readEntries(workingDirectory).filter(entry => entry.missionId !== missionId);
  writeEntries(workingDirectory, remaining);
}

/** Live (non-expired) active-session entries for this working directory. */
export function readActiveSessions(workingDirectory: string): ActiveSessionEntry[] {
  return readEntries(workingDirectory);
}

export type ResolvedMission = { missionId: string; ambiguous: boolean };

/**
 * Resolve which mission is active for a working directory when the caller has
 * no explicit MISSION_ID. Returns `null` when nobody is attached here. When more
 * than one session is concurrently attached in the same directory (a shared
 * worktree), attribution is ambiguous from cwd alone — callers should treat that
 * as "no confident answer" rather than guess (Layer 3 adds proper cross-session
 * claims; this only needs to not mis-attribute).
 */
export function resolveActiveMissionForCwd(workingDirectory: string): ResolvedMission | null {
  const entries = readActiveSessions(workingDirectory);
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    const [entry] = entries;
    return entry ? { missionId: entry.missionId, ambiguous: false } : null;
  }
  // Most-recently-attached wins, but flagged ambiguous so callers can log it.
  const mostRecent = [...entries].sort((a, b) => b.attachedAt.localeCompare(a.attachedAt))[0];
  return mostRecent ? { missionId: mostRecent.missionId, ambiguous: true } : null;
}
