import { type Permission, PERMISSIONS } from '@overlord/auth';

import type { ServiceContext } from '../packages/core/service/context.ts';
import { listAttachments } from '../packages/core/service/missions.ts';
import { discoverProject } from '../packages/core/service/projects.ts';
import {
  addObjectivesToMission,
  askQuestion,
  attachSession,
  authStatus,
  type ChangeRationaleInput,
  connectSession,
  deliverSession,
  discussObjective,
  heartbeatSession,
  listSharedContext,
  loadMissionContext,
  protocolCreate,
  protocolPrompt,
  recordHookEvent,
  recordWork,
  resumeFollowUp,
  searchMissions,
  updateSession,
  writeSharedContext
} from '../packages/core/service/protocol.ts';

import {
  buildWebappServiceContextForWorkspace,
  getActorWorkspaceUserId,
  serviceDatabaseClient,
  WORKSPACE
} from './db.ts';
import { ApiError } from './errors.ts';
import { requirePermission, requireWorkspacePermission } from './rbac.ts';
import { callerWorkspaceMemberships } from './repository.ts';

// ---- Protocol command dispatch -------------------------------------------
//
// The published npm CLI is client-only: `ovld protocol <subcommand>` forwards
// to `POST /api/protocol/<subcommand>` carrying the parsed flags/positional
// args/stdin. This module turns that envelope back into a service-layer call so
// every protocol command shares one implementation with the rest of Overlord.

/** Envelope posted by the CLI's `runProtocolCommand`. */
export interface ProtocolRequestBody {
  args?: string[];
  positional?: string[];
  flags?: Record<string, string | boolean>;
  /**
   * Per-flag file/stdin payloads, keyed by the `--*-file` flag name. Replaces the
   * single `stdin` field so multiple file payloads in one call no longer collide.
   */
  fileInputs?: Record<string, string>;
  /** Legacy single-payload field; still honored when `fileInputs` lacks the flag. */
  stdin?: string;
  externalSessionId?: string | null;
}

/**
 * Build a service context bound to the web server's active workspace. Reads the
 * live `WORKSPACE` / `getActorWorkspaceUserId()` bindings so workspace switching
 * is observed, and tags writes with the `protocol` source for the change feed.
 */
function buildContext(): ServiceContext {
  return {
    db: serviceDatabaseClient(),
    workspace: { id: WORKSPACE.id, slug: WORKSPACE.slug, name: WORKSPACE.name },
    actorWorkspaceUserId: getActorWorkspaceUserId(),
    source: 'protocol'
  };
}

async function protocolWorkspaceId(body: ProtocolRequestBody): Promise<string | null> {
  const scopes = await callerWorkspaceMemberships();
  if (scopes.length === 0) return null;
  const workspaceIds = scopes.map(scope => scope.workspaceId);
  const placeholders = workspaceIds.map(() => '?').join(', ');
  const db = serviceDatabaseClient();

  const executionRequestId = strFlag(body, '--execution-request-id');
  if (executionRequestId) {
    const request = await db.get<{ workspace_id: string }>(
      `SELECT workspace_id FROM execution_requests
        WHERE id = ? AND deleted_at IS NULL AND workspace_id IN (${placeholders})`,
      [executionRequestId, ...workspaceIds]
    );
    if (request) return request.workspace_id;
  }

  const sessionKey = strFlag(body, '--session-key');
  if (sessionKey) {
    const session = await db.get<{ workspace_id: string }>(
      `SELECT workspace_id FROM agent_sessions
        WHERE session_key = ? AND workspace_id IN (${placeholders})`,
      [sessionKey, ...workspaceIds]
    );
    if (session) return session.workspace_id;
  }

  const missionRef = strFlag(body, '--mission-id');
  if (missionRef) {
    const byId = await db.get<{ workspace_id: string }>(
      `SELECT workspace_id FROM missions
        WHERE id = ? AND deleted_at IS NULL AND workspace_id IN (${placeholders})`,
      [missionRef, ...workspaceIds]
    );
    if (byId) return byId.workspace_id;

    const byDisplay = await db.all<{ workspace_id: string }>(
      `SELECT workspace_id FROM missions
        WHERE display_id = ? AND deleted_at IS NULL AND workspace_id IN (${placeholders})`,
      [missionRef, ...workspaceIds]
    );
    if (byDisplay.length > 1) {
      throw new ApiError(409, `Mission reference is ambiguous across workspaces: ${missionRef}`);
    }
    if (byDisplay[0]) return byDisplay[0].workspace_id;
  }

  const projectRef = strFlag(body, '--project-id');
  if (!projectRef) return null;
  const projectById = await db.get<{ workspace_id: string }>(
    `SELECT workspace_id FROM projects
      WHERE id = ? AND deleted_at IS NULL AND workspace_id IN (${placeholders})`,
    [projectRef, ...workspaceIds]
  );
  if (projectById) return projectById.workspace_id;

  const projects = await db.all<{ workspace_id: string }>(
    `SELECT workspace_id FROM projects
      WHERE (slug = ? OR lower(name) = lower(?))
        AND deleted_at IS NULL AND workspace_id IN (${placeholders})`,
    [projectRef, projectRef, ...workspaceIds]
  );
  if (projects.length > 1) {
    throw new ApiError(409, `Project reference is ambiguous across workspaces: ${projectRef}`);
  }
  return projects[0]?.workspace_id ?? null;
}

async function buildProtocolContext(
  body: ProtocolRequestBody,
  permission: Permission | null
): Promise<ServiceContext> {
  const workspaceId = await protocolWorkspaceId(body);
  if (!workspaceId) {
    if (permission) await requirePermission(permission);
    return buildContext();
  }
  const workspaceUserId = permission
    ? await requireWorkspacePermission({ workspaceId, permission })
    : (await callerWorkspaceMemberships()).find(scope => scope.workspaceId === workspaceId)
        ?.workspaceUserId;
  if (!workspaceUserId) throw new ApiError(404, 'Workspace not found');
  const ctx = await buildWebappServiceContextForWorkspace(
    workspaceId,
    serviceDatabaseClient(),
    workspaceUserId
  );
  return { ...ctx, source: 'protocol' };
}

// ---- flag/argument helpers -----------------------------------------------

function flagsOf(body: ProtocolRequestBody): Record<string, string | boolean> {
  return body.flags ?? {};
}

/** String value of a `--flag value` pair, or undefined for absent/boolean flags. */
function strFlag(body: ProtocolRequestBody, name: string): string | undefined {
  const value = flagsOf(body)[name];
  return typeof value === 'string' ? value : undefined;
}

/** True when a boolean flag is present (`--flag` or `--flag true`). */
function boolFlag(body: ProtocolRequestBody, name: string): boolean {
  const value = flagsOf(body)[name];
  return value === true || value === 'true';
}

/** True when the flag appears at all, regardless of value. */
function hasFlag(body: ProtocolRequestBody, name: string): boolean {
  return name in flagsOf(body);
}

/**
 * Resolve the per-flag file payload the CLI streamed for `fileFlag`, falling back
 * to the legacy single `stdin` field for older clients. Each `--*-file` flag now
 * carries its own content in `fileInputs`, so multiple file payloads in one call
 * no longer collide.
 */
function fileInput(body: ProtocolRequestBody, fileFlag: string): string | undefined {
  const perFlag = body.fileInputs?.[fileFlag];
  if (typeof perFlag === 'string') return perFlag;
  return body.stdin ?? '';
}

/**
 * Resolve text supplied either inline (`--summary "..."`) or via the file
 * variant (`--summary-file -`). The CLI streams file contents in the `fileInputs`
 * envelope, so any presence of the file flag means "use that payload" — this is
 * how the contract avoids shell-quoting failures for special characters.
 */
function resolveInput(
  body: ProtocolRequestBody,
  valueFlag: string,
  fileFlag: string
): string | undefined {
  const direct = strFlag(body, valueFlag);
  if (direct !== undefined) return direct;
  if (hasFlag(body, fileFlag)) return fileInput(body, fileFlag);
  return undefined;
}

/** Native session id: explicit flag wins, else the CLI's resolved value. */
function externalSessionId(body: ProtocolRequestBody): string | null | undefined {
  const flag = strFlag(body, '--external-session-id');
  if (flag !== undefined) return flag;
  return body.externalSessionId ?? undefined;
}

function requireFlag(body: ProtocolRequestBody, name: string): string {
  const value = strFlag(body, name);
  if (value === undefined || value.trim() === '') {
    throw new ApiError(400, `Missing required flag: ${name}`);
  }
  return value;
}

/** Parse a JSON flag supplied inline (`--x-json`) or via stdin (`--x-file`). */
function parseJsonInput<T>(
  body: ProtocolRequestBody,
  jsonFlag: string,
  fileFlag: string
): T | undefined {
  const raw = resolveInput(body, jsonFlag, fileFlag);
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new ApiError(
      400,
      `Invalid JSON for ${jsonFlag}`,
      err instanceof Error ? err.message : undefined
    );
  }
}

function csvFlag(body: ProtocolRequestBody, name: string): string[] | undefined {
  const value = strFlag(body, name);
  if (value === undefined) return undefined;
  const parts = value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function intFlag(body: ProtocolRequestBody, name: string): number | undefined {
  const value = strFlag(body, name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Objective text for create/prompt/record-work: `--objective`, else positional. */
function objectiveText(body: ProtocolRequestBody): string {
  const flag = strFlag(body, '--objective');
  if (flag !== undefined && flag.trim() !== '') return flag;
  const positional = (body.positional ?? []).join(' ').trim();
  if (positional) return positional;
  throw new ApiError(400, 'Missing objective text (use --objective or a positional argument)');
}

type ObjectiveInput = {
  objective: string;
  title?: string | null;
  autoAdvance?: boolean;
  resourceKey?: string | null;
};

/** Objective array for create/prompt: `--objectives-json`, else a one-item `--objective`. */
function objectiveInputs(body: ProtocolRequestBody): ObjectiveInput[] {
  const parsed =
    parseJsonInput<ObjectiveInput[]>(body, '--objectives-json', '--objectives-file') ?? null;
  if (parsed) {
    if (!Array.isArray(parsed)) {
      throw new ApiError(400, 'objectives-json must be an array');
    }
    return parsed;
  }
  const resourceKey = strFlag(body, '--resource');
  return [
    {
      objective: objectiveText(body),
      ...(resourceKey ? { resourceKey } : {})
    }
  ];
}

type ArtifactInput = {
  type: string;
  label: string;
  content?: string | null;
  url?: string | null;
};

type ChangedFileInput = {
  filePath: string;
  vcsStatus?: string | null;
  attribution?: 'mine' | 'claimed' | 'unclaimed';
  claimedByMissionIds?: string[];
};

type Handler = (ctx: ServiceContext, body: ProtocolRequestBody) => unknown;

// ---- subcommand handlers -------------------------------------------------

const handlers: Record<string, Handler> = {
  // Session lifecycle ------------------------------------------------------
  attach: (ctx, body) =>
    attachSession({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      agentIdentifier: strFlag(body, '--agent') ?? 'unknown',
      modelIdentifier: strFlag(body, '--model') ?? null,
      existingSessionKey: strFlag(body, '--session-key') ?? null,
      externalSessionId: externalSessionId(body),
      executionRequestId: strFlag(body, '--execution-request-id') ?? null,
      executionTargetId: strFlag(body, '--execution-target-id') ?? null
    }),

  update: (ctx, body) =>
    updateSession({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      sessionKey: requireFlag(body, '--session-key'),
      summary: resolveInput(body, '--summary', '--summary-file') ?? '',
      phase: strFlag(body, '--phase') ?? null,
      eventType: strFlag(body, '--event-type') ?? 'update',
      payloadJson: parseJsonInput<Record<string, unknown>>(
        body,
        '--payload-json',
        '--payload-file'
      ),
      externalUrl: strFlag(body, '--external-url') ?? null,
      externalSessionId: externalSessionId(body),
      beginFollowUpWork: boolFlag(body, '--begin-follow-up-work'),
      followUpIntent: strFlag(body, '--follow-up-intent') ?? null,
      changedFiles: parseJsonInput<ChangedFileInput[]>(
        body,
        '--changed-files-json',
        '--changed-files-file'
      ),
      changeRationales: parseJsonInput<Array<Record<string, unknown>>>(
        body,
        '--change-rationales-json',
        '--change-rationales-file'
      )
    }),

  heartbeat: (ctx, body) =>
    heartbeatSession({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      sessionKey: requireFlag(body, '--session-key'),
      phase: strFlag(body, '--phase') ?? null,
      note: strFlag(body, '--note') ?? null
    }),

  ask: (ctx, body) =>
    askQuestion({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      sessionKey: requireFlag(body, '--session-key'),
      question: resolveInput(body, '--question', '--question-file') ?? ''
    }),

  deliver: (ctx, body) =>
    deliverSession({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      sessionKey: requireFlag(body, '--session-key'),
      summary: resolveInput(body, '--summary', '--summary-file') ?? '',
      artifacts: parseJsonInput<ArtifactInput[]>(body, '--artifacts', '--artifacts-file') ?? [],
      changeRationales:
        parseJsonInput<ChangeRationaleInput[]>(
          body,
          '--change-rationales-json',
          '--change-rationales-file'
        ) ?? [],
      changedFiles: parseJsonInput<ChangedFileInput[]>(
        body,
        '--changed-files-json',
        '--changed-files-file'
      ),
      noFileChanges: boolFlag(body, '--no-file-changes'),
      skipRationaleFor:
        parseJsonInput<Array<{ filePath?: string; file_path?: string; reason: string }>>(
          body,
          '--skip-rationale-for-json',
          '--skip-rationale-for-file'
        ) ?? [],
      observedDirtyPaths: parseJsonInput<string[]>(
        body,
        '--observed-dirty-paths-json',
        '--observed-dirty-paths-file'
      ),
      payloadJson: parseJsonInput<Record<string, unknown>>(
        body,
        '--payload-json',
        '--payload-file'
      ),
      verificationSummary: strFlag(body, '--verification-summary') ?? null,
      followUpNotes: strFlag(body, '--follow-up-notes') ?? null
    }),

  'hook-event': (ctx, body) =>
    recordHookEvent({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      hookType: requireFlag(body, '--hook-type'),
      prompt: resolveInput(body, '--prompt', '--prompt-file') ?? '',
      sessionKey: strFlag(body, '--session-key') ?? null,
      externalSessionId: externalSessionId(body) ?? null,
      turnIndex: strFlag(body, '--turn-index') ?? null
    }),

  'resume-follow-up': (ctx, body) =>
    resumeFollowUp({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      objectiveId: strFlag(body, '--objective-id') ?? null,
      agentIdentifier: strFlag(body, '--agent') ?? 'unknown',
      modelIdentifier: strFlag(body, '--model') ?? null,
      externalSessionId: externalSessionId(body),
      summary: resolveInput(body, '--summary', '--summary-file') ?? null,
      executionTargetId: strFlag(body, '--execution-target-id') ?? null
    }),

  // Mission creation and discovery -----------------------------------------
  create: (ctx, body) =>
    protocolCreate({
      ctx,
      projectId: strFlag(body, '--project-id') ?? null,
      objectives: objectiveInputs(body),
      title: strFlag(body, '--title') ?? null
    }),

  prompt: (ctx, body) =>
    protocolPrompt({
      ctx,
      projectId: strFlag(body, '--project-id') ?? null,
      objectives: objectiveInputs(body),
      title: strFlag(body, '--title') ?? null,
      agentIdentifier: strFlag(body, '--agent') ?? 'unknown',
      externalSessionId: externalSessionId(body)
    }),

  'load-context': (ctx, body) =>
    loadMissionContext({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      executionTargetId: strFlag(body, '--execution-target-id') ?? null
    }),

  connect: (ctx, body) =>
    connectSession({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      agentIdentifier: strFlag(body, '--agent') ?? 'unknown',
      externalSessionId: externalSessionId(body)
    }),

  'search-missions': (ctx, body) =>
    searchMissions({
      ctx,
      query: strFlag(body, '--query') ?? null,
      statusTypes: csvFlag(body, '--status') ?? null,
      projectId: strFlag(body, '--project-id') ?? null,
      limit: intFlag(body, '--limit') ?? 25
    }),

  'discuss-objective': (ctx, body) =>
    discussObjective({ ctx, missionId: requireFlag(body, '--mission-id') }),

  'add-objectives': (ctx, body) =>
    addObjectivesToMission({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      objectives:
        parseJsonInput<
          Array<{ objective: string; title?: string | null; resourceKey?: string | null }>
        >(body, '--objectives-json', '--objectives-file') ?? []
    }),

  'record-work': (ctx, body) =>
    recordWork({
      ctx,
      projectId: strFlag(body, '--project-id') ?? null,
      summary: resolveInput(body, '--summary', '--summary-file') ?? '',
      objective: objectiveText(body),
      title: strFlag(body, '--title') ?? null,
      artifacts: parseJsonInput<ArtifactInput[]>(body, '--artifacts', '--artifacts-file') ?? [],
      changeRationales:
        parseJsonInput<ChangeRationaleInput[]>(
          body,
          '--change-rationales-json',
          '--change-rationales-file'
        ) ?? []
    }),

  // Shared context ---------------------------------------------------------
  'read-context': (ctx, body) =>
    listSharedContext({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      keySubstring: strFlag(body, '--key') ?? null,
      limit: intFlag(body, '--limit') ?? 50
    }),

  'write-context': (ctx, body) => {
    const valueJson = parseJsonInput<unknown>(body, '--value-json', '--value-file');
    const value = valueJson !== undefined ? valueJson : (strFlag(body, '--value') ?? '');
    return writeSharedContext({
      ctx,
      missionId: requireFlag(body, '--mission-id'),
      key: requireFlag(body, '--key'),
      value
    });
  },

  'attachment-list': async (ctx, body) => {
    const missionId = requireFlag(body, '--mission-id');
    const attachments = await listAttachments({ ctx, missionId });
    return attachments.map(a => ({
      ...a,
      url: `/api/storage/attachments/${encodeURIComponent(a.storageKey)}`
    }));
  },

  'attachment-download-url': async (ctx, body) => {
    const missionId = requireFlag(body, '--mission-id');
    const attachmentId = requireFlag(body, '--attachment-id');
    const attachments = await listAttachments({ ctx, missionId });
    const found = attachments.find(a => a.id === attachmentId);
    if (!found) throw new ApiError(404, `Attachment not found: ${attachmentId}`);
    return {
      id: found.id,
      filename: found.filename,
      contentType: found.mimeType,
      url: `/api/storage/attachments/${encodeURIComponent(found.storageKey)}`
    };
  },

  // Auth and discovery -----------------------------------------------------
  'auth-status': ctx => authStatus({ ctx }),

  'discover-project': (ctx, body) =>
    discoverProject({
      ctx,
      projectId: strFlag(body, '--project-id') ?? null,
      workingDirectory: strFlag(body, '--directory') ?? null
    }),

  // Predates the real `organizations` table/hierarchy (coo:135) — despite the
  // name, this returns only the caller's current *workspace* context (never
  // an organization row), kept as-is to avoid a breaking protocol rename.
  // Use `GET /api/organizations` (web) for real organization data.
  'list-organizations': ctx => [
    { id: ctx.workspace.id, slug: ctx.workspace.slug, name: ctx.workspace.name }
  ]
};

/**
 * RBAC permission each protocol subcommand requires. Enforced before dispatch so
 * a scoped `USER_TOKEN` (and any under-privileged actor) is rejected uniformly —
 * the `mission_lifecycle` scope grants exactly the set used here. `auth-status` is
 * intentionally ungated so any authenticated actor can check who it is.
 */
const SUBCOMMAND_PERMISSIONS: Record<string, Permission | null> = {
  attach: PERMISSIONS.SESSION_ATTACH,
  update: PERMISSIONS.EVENT_CREATE,
  heartbeat: PERMISSIONS.EVENT_CREATE,
  ask: PERMISSIONS.EVENT_CREATE,
  deliver: PERMISSIONS.EVENT_CREATE,
  'hook-event': PERMISSIONS.EVENT_CREATE,
  'resume-follow-up': PERMISSIONS.SESSION_ATTACH,
  create: PERMISSIONS.MISSION_CREATE,
  prompt: PERMISSIONS.MISSION_CREATE,
  'load-context': PERMISSIONS.MISSION_READ,
  connect: PERMISSIONS.SESSION_ATTACH,
  'search-missions': PERMISSIONS.MISSION_READ,
  'discuss-objective': PERMISSIONS.OBJECTIVE_SUBMIT,
  'add-objectives': PERMISSIONS.OBJECTIVE_UPDATE,
  'record-work': PERMISSIONS.MISSION_CREATE,
  'read-context': PERMISSIONS.MISSION_READ,
  'write-context': PERMISSIONS.MISSION_UPDATE,
  'attachment-list': PERMISSIONS.ARTIFACT_READ,
  'attachment-download-url': PERMISSIONS.ARTIFACT_READ,
  'auth-status': null,
  'discover-project': PERMISSIONS.PROJECT_READ,
  'list-organizations': PERMISSIONS.PROJECT_READ
};

/**
 * Dispatch a single `ovld protocol <subcommand>` invocation to the service
 * layer. Throws `ApiError(404)` for unknown subcommands; service-layer
 * validation surfaces as `ServiceError` (mapped to HTTP status by the caller).
 */
export async function runProtocolSubcommand(
  subcommand: string,
  body: ProtocolRequestBody
): Promise<unknown> {
  const handler = handlers[subcommand];
  if (!handler) {
    throw new ApiError(
      404,
      `Unknown protocol subcommand: ${subcommand}`,
      `Supported subcommands: ${Object.keys(handlers).sort().join(', ')}`
    );
  }
  const requiredPermission = SUBCOMMAND_PERMISSIONS[subcommand] ?? null;
  return handler(await buildProtocolContext(body, requiredPermission), body);
}
