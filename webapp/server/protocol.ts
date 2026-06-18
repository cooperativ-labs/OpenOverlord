import { type Permission, PERMISSIONS } from '@overlord/auth';
import { SEED_WORKSPACE_USER_ID } from '@overlord/database';

import type { ServiceContext } from '../../src/service/context.ts';
import { discoverProject } from '../../src/service/projects.ts';
import {
  addObjectivesToTicket,
  askQuestion,
  attachSession,
  authStatus,
  type ChangeRationaleInput,
  connectSession,
  deliverSession,
  discussObjective,
  heartbeatSession,
  listSharedContext,
  loadTicketContext,
  protocolCreate,
  protocolPrompt,
  recordHookEvent,
  recordWork,
  resumeFollowUp,
  searchTickets,
  updateSession,
  writeSharedContext
} from '../../src/service/protocol.ts';

import { ACTOR_WORKSPACE_USER_ID, db, WORKSPACE } from './db.ts';
import { ApiError } from './errors.ts';
import { requirePermission } from './rbac.ts';

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
  stdin?: string;
  externalSessionId?: string | null;
}

/**
 * Build a service context bound to the web server's active workspace. Reads the
 * live `WORKSPACE` / `ACTOR_WORKSPACE_USER_ID` bindings so workspace switching
 * is observed, and tags writes with the `protocol` source for the change feed.
 */
function buildContext(): ServiceContext {
  return {
    db,
    workspace: { id: WORKSPACE.id, slug: WORKSPACE.slug, name: WORKSPACE.name },
    actorWorkspaceUserId: ACTOR_WORKSPACE_USER_ID ?? SEED_WORKSPACE_USER_ID,
    source: 'protocol'
  };
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
 * Resolve text supplied either inline (`--summary "..."`) or via the file
 * variant (`--summary-file -`). The CLI streams file contents as the request
 * `stdin`, so any presence of the file flag means "use stdin" — this is how the
 * contract avoids shell-quoting failures for special characters.
 */
function resolveInput(
  body: ProtocolRequestBody,
  valueFlag: string,
  fileFlag: string
): string | undefined {
  const direct = strFlag(body, valueFlag);
  if (direct !== undefined) return direct;
  if (hasFlag(body, fileFlag)) return body.stdin ?? '';
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

type ObjectiveInput = { objective: string; title?: string | null; autoAdvance?: boolean };

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
  return [{ objective: objectiveText(body) }];
}

type ArtifactInput = {
  type: string;
  label: string;
  content?: string | null;
  url?: string | null;
};

type ChangedFileInput = { filePath: string; vcsStatus?: string | null };

type Handler = (ctx: ServiceContext, body: ProtocolRequestBody) => unknown;

// ---- subcommand handlers -------------------------------------------------

const handlers: Record<string, Handler> = {
  // Session lifecycle ------------------------------------------------------
  attach: (ctx, body) =>
    attachSession({
      ctx,
      ticketId: requireFlag(body, '--ticket-id'),
      agentIdentifier: strFlag(body, '--agent') ?? 'unknown',
      modelIdentifier: strFlag(body, '--model') ?? null,
      existingSessionKey: strFlag(body, '--session-key') ?? null,
      externalSessionId: externalSessionId(body)
    }),

  update: (ctx, body) =>
    updateSession({
      ctx,
      ticketId: requireFlag(body, '--ticket-id'),
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
      ticketId: requireFlag(body, '--ticket-id'),
      sessionKey: requireFlag(body, '--session-key'),
      phase: strFlag(body, '--phase') ?? null,
      note: strFlag(body, '--note') ?? null
    }),

  ask: (ctx, body) =>
    askQuestion({
      ctx,
      ticketId: requireFlag(body, '--ticket-id'),
      sessionKey: requireFlag(body, '--session-key'),
      question: resolveInput(body, '--question', '--question-file') ?? ''
    }),

  deliver: (ctx, body) =>
    deliverSession({
      ctx,
      ticketId: requireFlag(body, '--ticket-id'),
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
      ticketId: requireFlag(body, '--ticket-id'),
      hookType: requireFlag(body, '--hook-type'),
      prompt: resolveInput(body, '--prompt', '--prompt-file') ?? '',
      sessionKey: strFlag(body, '--session-key') ?? null,
      externalSessionId: externalSessionId(body) ?? null,
      turnIndex: strFlag(body, '--turn-index') ?? null
    }),

  'resume-follow-up': (ctx, body) =>
    resumeFollowUp({
      ctx,
      ticketId: requireFlag(body, '--ticket-id'),
      objectiveId: strFlag(body, '--objective-id') ?? null,
      agentIdentifier: strFlag(body, '--agent') ?? 'unknown',
      modelIdentifier: strFlag(body, '--model') ?? null,
      externalSessionId: externalSessionId(body),
      summary: resolveInput(body, '--summary', '--summary-file') ?? null
    }),

  // Ticket creation and discovery -----------------------------------------
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
    loadTicketContext({ ctx, ticketId: requireFlag(body, '--ticket-id') }),

  connect: (ctx, body) =>
    connectSession({
      ctx,
      ticketId: requireFlag(body, '--ticket-id'),
      agentIdentifier: strFlag(body, '--agent') ?? 'unknown',
      externalSessionId: externalSessionId(body)
    }),

  'search-tickets': (ctx, body) =>
    searchTickets({
      ctx,
      query: strFlag(body, '--query') ?? null,
      statusTypes: csvFlag(body, '--status') ?? null,
      projectId: strFlag(body, '--project-id') ?? null,
      limit: intFlag(body, '--limit') ?? 25
    }),

  'discuss-objective': (ctx, body) =>
    discussObjective({ ctx, ticketId: requireFlag(body, '--ticket-id') }),

  'add-objectives': (ctx, body) =>
    addObjectivesToTicket({
      ctx,
      ticketId: requireFlag(body, '--ticket-id'),
      objectives:
        parseJsonInput<Array<{ objective: string; title?: string | null }>>(
          body,
          '--objectives-json',
          '--objectives-file'
        ) ?? []
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
      ticketId: requireFlag(body, '--ticket-id'),
      keySubstring: strFlag(body, '--key') ?? null,
      limit: intFlag(body, '--limit') ?? 50
    }),

  'write-context': (ctx, body) => {
    const valueJson = parseJsonInput<unknown>(body, '--value-json', '--value-file');
    const value = valueJson !== undefined ? valueJson : (strFlag(body, '--value') ?? '');
    return writeSharedContext({
      ctx,
      ticketId: requireFlag(body, '--ticket-id'),
      key: requireFlag(body, '--key'),
      value
    });
  },

  'attachment-list': (ctx, body) =>
    loadTicketContext({ ctx, ticketId: requireFlag(body, '--ticket-id') }).attachments,

  // Auth and discovery -----------------------------------------------------
  'auth-status': ctx => authStatus({ ctx }),

  'discover-project': (ctx, body) =>
    discoverProject({
      ctx,
      projectId: strFlag(body, '--project-id') ?? null,
      workingDirectory: strFlag(body, '--directory') ?? null
    }),

  'list-organizations': ctx => [
    { id: ctx.workspace.id, slug: ctx.workspace.slug, name: ctx.workspace.name }
  ]
};

/**
 * RBAC permission each protocol subcommand requires. Enforced before dispatch so
 * a scoped `USER_TOKEN` (and any under-privileged actor) is rejected uniformly —
 * the `ticket_lifecycle` scope grants exactly the set used here. `auth-status` is
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
  create: PERMISSIONS.TICKET_CREATE,
  prompt: PERMISSIONS.TICKET_CREATE,
  'load-context': PERMISSIONS.TICKET_READ,
  connect: PERMISSIONS.SESSION_ATTACH,
  'search-tickets': PERMISSIONS.TICKET_READ,
  'discuss-objective': PERMISSIONS.OBJECTIVE_SUBMIT,
  'add-objectives': PERMISSIONS.OBJECTIVE_UPDATE,
  'record-work': PERMISSIONS.TICKET_CREATE,
  'read-context': PERMISSIONS.TICKET_READ,
  'write-context': PERMISSIONS.TICKET_UPDATE,
  'attachment-list': PERMISSIONS.ARTIFACT_READ,
  'auth-status': null,
  'discover-project': PERMISSIONS.PROJECT_READ,
  'list-organizations': PERMISSIONS.PROJECT_READ
};

/**
 * Dispatch a single `ovld protocol <subcommand>` invocation to the service
 * layer. Throws `ApiError(404)` for unknown subcommands; service-layer
 * validation surfaces as `ServiceError` (mapped to HTTP status by the caller).
 */
export function runProtocolSubcommand(subcommand: string, body: ProtocolRequestBody): unknown {
  const handler = handlers[subcommand];
  if (!handler) {
    throw new ApiError(
      404,
      `Unknown protocol subcommand: ${subcommand}`,
      `Supported subcommands: ${Object.keys(handlers).sort().join(', ')}`
    );
  }
  const requiredPermission = SUBCOMMAND_PERMISSIONS[subcommand];
  if (requiredPermission) requirePermission(requiredPermission);
  return handler(buildContext(), body);
}
