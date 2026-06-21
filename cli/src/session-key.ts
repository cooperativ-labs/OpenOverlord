import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveGlobalDataDir } from './config.js';

// Client-side cache of the protocol session key returned by `attach`. Every Bash
// tool call is a fresh shell, so a key captured at attach is otherwise gone by the
// next `ovld protocol` command unless the agent threads it through manually. The
// cache is scoped strictly to (resolve(workingDirectory), ticketId) — the same
// keying `native-session.ts` uses for `externalSessionId` — so a key can never
// leak across working directories or tickets.

function sessionKeyCachePath({
  ticketId,
  workingDirectory
}: {
  ticketId: string;
  workingDirectory: string;
}): string {
  const key = createHash('sha256')
    .update(`${path.resolve(workingDirectory)}\0${ticketId}`)
    .digest('hex');
  return path.join(resolveGlobalDataDir(), 'protocol-session-keys', key);
}

/** Cached session key for this (workingDir, ticket), or undefined when absent. */
export function readCachedSessionKey({
  ticketId,
  workingDirectory
}: {
  ticketId: string;
  workingDirectory: string;
}): string | undefined {
  try {
    const filePath = sessionKeyCachePath({ ticketId, workingDirectory });
    if (!existsSync(filePath)) return undefined;
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { sessionKey?: unknown };
    return typeof raw.sessionKey === 'string' && raw.sessionKey.trim()
      ? raw.sessionKey.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the session key returned by attach/resume-follow-up for later reuse. */
export function writeCachedSessionKey({
  ticketId,
  workingDirectory,
  sessionKey
}: {
  ticketId: string;
  workingDirectory: string;
  sessionKey: string;
}): void {
  try {
    const trimmed = sessionKey.trim();
    if (!trimmed) return;
    const filePath = sessionKeyCachePath({ ticketId, workingDirectory });
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ sessionKey: trimmed, updatedAt: new Date().toISOString() }),
      { mode: 0o600 }
    );
  } catch {
    // Best-effort: a failed write just means the agent must pass --session-key
    // explicitly, the same as before this cache existed.
  }
}

/** Drop the cached key once the session ends so a stale key can't be reused. */
export function clearCachedSessionKey({
  ticketId,
  workingDirectory
}: {
  ticketId: string;
  workingDirectory: string;
}): void {
  try {
    const filePath = sessionKeyCachePath({ ticketId, workingDirectory });
    if (existsSync(filePath)) rmSync(filePath);
  } catch {
    // Best-effort: a stale key at worst fails a downstream call with an invalid
    // session error, which the agent already handles by re-attaching.
  }
}
