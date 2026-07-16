import { readFileSync } from 'node:fs';
import path from 'node:path';

import { recordBashObservedChanges, recordRationaleNotes, recordTouchedFiles } from './vcs.js';
import { resolveActiveMissionForCwd } from './vcs-sessions.js';

/**
 * Shared implementation behind `ovld protocol record-touched`.
 *
 * Any adapter's file-editing-tool hook (Claude's PostToolUse today; Codex/Cursor
 * once they grow one) can pipe its native hook JSON on stdin here instead of
 * reimplementing the touched-files log and rationale-note bookkeeping itself.
 * The only per-adapter assumption is the payload shape below (`tool_name`,
 * `tool_input.file_path` / `notebook_path` / `edits`, `cwd`, `transcript_path`),
 * which mirrors Claude Code's hook body; adapters with a different shape should
 * normalize to this shape before piping in.
 */

type HookPayload = {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
};

type EditCandidate = { filePath: string; editCount: number };

function collectCandidates(toolInput: Record<string, unknown>): EditCandidate[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  const bump = (raw: unknown, amount: number) => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!counts.has(trimmed)) order.push(trimmed);
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + amount);
  };

  bump(toolInput.file_path, 1);
  bump(toolInput.notebook_path, 1);

  const edits = toolInput.edits;
  if (Array.isArray(edits)) {
    const topLevelPath = toolInput.file_path;
    if (typeof topLevelPath === 'string' && topLevelPath.trim()) {
      counts.set(topLevelPath.trim(), (counts.get(topLevelPath.trim()) ?? 0) - 1);
    }
    for (const edit of edits) {
      if (edit && typeof edit === 'object') {
        const value = (edit as Record<string, unknown>).file_path ?? topLevelPath;
        bump(value, 1);
      }
    }
  }

  return order.map(filePath => ({ filePath, editCount: Math.max(counts.get(filePath) ?? 1, 1) }));
}

function compact(value: string | null | undefined, limit = 500): string | null {
  if (typeof value !== 'string') return null;
  const text = value.split(/\s+/).filter(Boolean).join(' ');
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

function editIntent({
  toolName,
  filePath,
  editCount
}: {
  toolName: string;
  filePath: string;
  editCount: number;
}): string {
  if (toolName === 'Write') return 'wrote or replaced the file';
  if (toolName === 'MultiEdit' || editCount > 1)
    return `applied ${editCount} targeted text edit(s)`;
  if (toolName === 'Edit') return 'replaced selected text';
  if (/notebook/i.test(filePath) || /notebook/i.test(toolName)) return 'edited notebook content';
  return `edited via ${toolName}`;
}

/** Best-effort: last assistant message text from the transcript, for rationale context. */
function recentAssistantContext(transcriptPath: unknown): string | null {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return null;
  try {
    const lines = readFileSync(transcriptPath, 'utf8').split('\n').slice(-200);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof event !== 'object' || event === null) continue;
      const record = event as Record<string, unknown>;
      const message = record.message as Record<string, unknown> | undefined;
      const role = message?.role ?? record.type;
      if (role !== 'assistant') continue;
      const content = message?.content ?? record.content;
      const texts: string[] = [];
      if (typeof content === 'string') {
        texts.push(content);
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (
            item &&
            typeof item === 'object' &&
            (item as Record<string, unknown>).type === 'text'
          ) {
            const text = (item as Record<string, unknown>).text;
            if (typeof text === 'string') texts.push(text);
          }
        }
      }
      const compacted = compact(texts.join(' '));
      if (compacted) return compacted;
    }
    return null;
  } catch {
    return null;
  }
}

export type RecordTouchedResult =
  | { recorded: true; missionId: string; ambiguous: boolean; files: number }
  | { recorded: false; reason: string };

/**
 * Parse a hook payload and append its edited files to the resolved mission's
 * touched-files log + rationale notes. `missionOverride` (from `--mission-id` or
 * the `MISSION_ID` env var) always wins over manifest resolution.
 */
export function recordTouchedFromPayload({
  rawPayload,
  missionOverride,
  fallbackCwd
}: {
  rawPayload: string;
  missionOverride?: string;
  fallbackCwd: string;
}): RecordTouchedResult {
  let payload: HookPayload;
  try {
    payload = JSON.parse(rawPayload) as HookPayload;
  } catch {
    return { recorded: false, reason: 'invalid JSON payload' };
  }

  const toolInputRaw = payload.tool_input;
  const toolInput =
    toolInputRaw && typeof toolInputRaw === 'object'
      ? (toolInputRaw as Record<string, unknown>)
      : {};
  const toolName =
    typeof payload.tool_name === 'string' && payload.tool_name.trim()
      ? payload.tool_name.trim()
      : 'file edit';

  const cwd =
    typeof payload.cwd === 'string' && payload.cwd.trim() ? payload.cwd.trim() : fallbackCwd;
  const workingDirectory = path.resolve(cwd);

  const trimmedOverride = missionOverride?.trim();
  let missionId: string;
  let ambiguous = false;
  if (trimmedOverride) {
    missionId = trimmedOverride;
  } else {
    const resolved = resolveActiveMissionForCwd(workingDirectory);
    if (!resolved) {
      return { recorded: false, reason: 'no active session manifest entry for this cwd' };
    }
    missionId = resolved.missionId;
    ambiguous = resolved.ambiguous;
  }

  if (toolName === 'Bash' || toolName === 'Shell') {
    // Shell tools never name the files they change (codegen, package managers, `git mv`,
    // build scripts), so there is nothing to extract from `tool_input`. Instead,
    // diff the current worktree against the last-seen snapshot for this session and
    // fold anything newly dirty into the touched-files log as positive evidence.
    const { addedCount } = recordBashObservedChanges({ workingDirectory, missionId });
    return { recorded: true, missionId, ambiguous, files: addedCount };
  }

  const candidates = collectCandidates(toolInput);
  if (candidates.length === 0) return { recorded: false, reason: 'no file candidates in payload' };

  const transcriptContext = recentAssistantContext(payload.transcript_path);

  recordTouchedFiles({
    workingDirectory,
    missionId,
    files: candidates.map(candidate => candidate.filePath)
  });
  recordRationaleNotes({
    workingDirectory,
    missionId,
    notes: candidates.map(candidate => ({
      filePath: candidate.filePath,
      toolName: compact(toolName, 80),
      intent: compact(
        editIntent({ toolName, filePath: candidate.filePath, editCount: candidate.editCount })
      ),
      transcriptContext
    }))
  });

  return { recorded: true, missionId, ambiguous, files: candidates.length };
}
