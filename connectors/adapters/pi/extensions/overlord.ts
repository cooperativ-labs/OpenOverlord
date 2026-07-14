import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const missionId = process.env.MISSION_ID ?? process.env.OVERLORD_MISSION_ID ?? '';
const executionRequestId = process.env.OVERLORD_EXECUTION_REQUEST_ID ?? '';
const sessionKey = process.env.SESSION_KEY ?? '';

function externalSessionId(ctx: ExtensionContext): string | null {
  const id = ctx.sessionManager.getSessionId().trim();
  return id || null;
}

async function cacheNativeSession(ctx: ExtensionContext): Promise<void> {
  if (!missionId) return;
  const sessionId = externalSessionId(ctx);
  if (!sessionId) return;

  const key = createHash('sha256').update(`${ctx.cwd}\0${missionId}\0pi`).digest('hex');
  const directory = path.join(homedir(), '.ovld', 'native-sessions');

  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, key),
    JSON.stringify({ agent: 'pi', missionId, externalSessionId: sessionId }),
    'utf8'
  );
}

export default function overlordPiExtension(pi: ExtensionAPI): void {
  let skipFirstInput = Boolean(missionId && executionRequestId);
  let turnIndex = 0;

  pi.on('session_start', (_event, ctx) => {
    void cacheNativeSession(ctx).catch(() => {});
  });

  pi.on('input', (event, ctx) => {
    void cacheNativeSession(ctx).catch(() => {});

    if (!missionId || event.source === 'extension' || event.text.trim().length === 0) {
      return { action: 'continue' };
    }
    if (skipFirstInput) {
      skipFirstInput = false;
      return { action: 'continue' };
    }

    const args = [
      'protocol',
      'hook-event',
      '--hook-type',
      'UserPromptSubmit',
      '--mission-id',
      missionId,
      '--prompt',
      event.text,
      '--turn-index',
      String(++turnIndex)
    ];
    const sessionId = externalSessionId(ctx);
    if (sessionId) args.push('--external-session-id', sessionId);
    if (sessionKey) args.push('--session-key', sessionKey);

    void pi.exec('ovld', args).catch(() => {});
    return { action: 'continue' };
  });
}
