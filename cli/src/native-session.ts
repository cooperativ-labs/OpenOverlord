import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveGlobalDataDir } from './config.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function sessionCachePath({
  agent,
  missionId,
  workingDirectory
}: {
  agent: string;
  missionId: string;
  workingDirectory: string;
}): string {
  const key = createHash('sha256')
    .update(`${path.resolve(workingDirectory)}\0${missionId}\0${agent}`)
    .digest('hex');
  return path.join(resolveGlobalDataDir(), 'native-sessions', key);
}

function readCachedNativeSessionId({
  agent,
  missionId,
  workingDirectory
}: {
  agent: string;
  missionId: string;
  workingDirectory: string;
}): string | undefined {
  try {
    const filePath = sessionCachePath({ agent, missionId, workingDirectory });
    if (!existsSync(filePath)) return undefined;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { externalSessionId?: unknown };
    return typeof raw.externalSessionId === 'string' && raw.externalSessionId.trim()
      ? raw.externalSessionId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function detectCodexSessionIdFromDisk(workingDirectory: string): string | undefined {
  const sessionsDir = path.join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsDir)) return undefined;

  const candidates: Array<{ mtime: number; filePath: string }> = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      try {
        candidates.push({ mtime: statSync(filePath).mtimeMs, filePath });
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  };

  try {
    visit(sessionsDir);
  } catch {
    return undefined;
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  let fallback: string | undefined;

  for (const candidate of candidates.slice(0, 25)) {
    let nativeId: string | undefined;
    let cwd: string | undefined;
    try {
      const [firstLine = ''] = readFileSync(candidate.filePath, 'utf8').split(/\r?\n/, 1);
      const obj = JSON.parse(firstLine) as Record<string, unknown>;
      const payload =
        obj.payload && typeof obj.payload === 'object'
          ? (obj.payload as Record<string, unknown>)
          : obj;
      if (typeof payload.id === 'string') nativeId = payload.id.match(UUID_RE)?.[0];
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
    } catch {
      nativeId = undefined;
    }
    nativeId ??= path.basename(candidate.filePath).match(UUID_RE)?.[0];
    if (!nativeId) continue;
    fallback ??= nativeId;
    if (cwd && path.resolve(cwd) === path.resolve(workingDirectory)) return nativeId;
  }

  return fallback;
}

export function resolveNativeSessionId({
  explicit,
  agent,
  missionId,
  workingDirectory = process.cwd(),
  env = process.env
}: {
  explicit?: string;
  agent: string;
  missionId: string;
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
}): string | null | undefined {
  if (explicit !== undefined) {
    const trimmed = explicit.trim();
    return trimmed === 'null' ? null : trimmed || undefined;
  }

  const normalizedAgent = agent.toLowerCase();
  if (normalizedAgent === 'codex') {
    return (
      env.CODEX_THREAD_ID?.trim() ||
      env.CODEX_SESSION_ID?.trim() ||
      readCachedNativeSessionId({ agent: 'codex', missionId, workingDirectory }) ||
      detectCodexSessionIdFromDisk(workingDirectory)
    );
  }

  if (normalizedAgent === 'claude') {
    return readCachedNativeSessionId({ agent: 'claude', missionId, workingDirectory });
  }

  if (normalizedAgent === 'cursor') {
    return readCachedNativeSessionId({ agent: 'cursor', missionId, workingDirectory });
  }

  return readCachedNativeSessionId({ agent: normalizedAgent, missionId, workingDirectory });
}
