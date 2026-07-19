import type { NextFunction, Request, Response } from 'express';

import type { ProtocolRequestBody } from '../backend/protocol.ts';
import { runProtocolSubcommand } from '../backend/protocol.ts';

import { hostedMcpToolDefinitions, type ToolDefinition } from './tool-catalog.ts';
import { hostedMcpWidgetResources, readHostedMcpWidget } from './widgets.ts';

const MCP_PROTOCOL_VERSION = '2025-11-25';

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

type ToolEntry = ToolDefinition & {
  handler: ToolHandler;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = optionalString(args, name);
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function protocolBody(flags: Record<string, string | boolean>): ProtocolRequestBody {
  return { flags };
}

function jsonText(value: unknown): ToolCallResult {
  // Every tool declares an object outputSchema, and MCP clients validate the
  // result's `structuredContent` against it. A bare array or primitive (e.g. the
  // add-objectives / search-missions handlers return `ObjectiveSummary[]` /
  // `MissionSummary[]`) fails client-side with
  // "structuredContent: Input should be a valid dictionary" even though the write
  // succeeded server-side. Wrap non-dictionary results so structuredContent is
  // always a dictionary; the text content mirrors it.
  const structured = isRecord(value) ? value : { results: value };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(structured, null, 2)
      }
    ],
    structuredContent: structured
  };
}

function toolErrorText(error: unknown): ToolCallResult {
  const message =
    error instanceof Error ? error.message : 'Overlord could not complete this tool call.';
  return {
    content: [{ type: 'text', text: message }],
    isError: true
  };
}

const toolHandlers: Record<string, ToolHandler> = {
  overlord_resolve_project: args =>
    runProtocolSubcommand(
      'discover-project',
      protocolBody({
        ...(optionalString(args, 'projectId')
          ? { '--project-id': requiredString(args, 'projectId') }
          : {}),
        ...(optionalString(args, 'directory')
          ? { '--directory': requiredString(args, 'directory') }
          : {})
      })
    ),
  overlord_search_missions: args =>
    runProtocolSubcommand(
      'search-missions',
      protocolBody({
        ...(optionalString(args, 'query') ? { '--query': requiredString(args, 'query') } : {}),
        ...(optionalString(args, 'status') ? { '--status': requiredString(args, 'status') } : {}),
        ...(optionalString(args, 'projectId')
          ? { '--project-id': requiredString(args, 'projectId') }
          : {}),
        ...(typeof args.limit === 'number' && Number.isFinite(args.limit)
          ? { '--limit': String(Math.trunc(args.limit)) }
          : {})
      })
    ),
  overlord_create_mission: args =>
    runProtocolSubcommand(
      'create',
      protocolBody({
        '--project-id': requiredString(args, 'projectId'),
        '--objective': requiredString(args, 'objective'),
        ...(optionalString(args, 'title') ? { '--title': requiredString(args, 'title') } : {}),
        ...(optionalString(args, 'resourceKey')
          ? { '--resource': requiredString(args, 'resourceKey') }
          : {})
      })
    ),
  overlord_load_mission_context: args =>
    runProtocolSubcommand(
      'load-context',
      protocolBody({
        '--mission-id': requiredString(args, 'missionId'),
        ...(optionalString(args, 'executionTargetId')
          ? { '--execution-target-id': requiredString(args, 'executionTargetId') }
          : {})
      })
    ),
  overlord_add_objectives: args => {
    if (!Array.isArray(args.objectives)) {
      throw new Error('objectives must be an array');
    }
    return runProtocolSubcommand('add-objectives', {
      flags: { '--mission-id': requiredString(args, 'missionId'), '--objectives-file': true },
      fileInputs: { '--objectives-file': JSON.stringify(args.objectives) }
    });
  },
  overlord_attach_session: args =>
    runProtocolSubcommand(
      'attach',
      protocolBody({
        '--mission-id': requiredString(args, 'missionId'),
        '--agent': optionalString(args, 'agent') ?? 'hosted-mcp',
        ...(optionalString(args, 'model') ? { '--model': requiredString(args, 'model') } : {}),
        ...(optionalString(args, 'executionTargetId')
          ? { '--execution-target-id': requiredString(args, 'executionTargetId') }
          : {})
      })
    ),
  overlord_update_session: args =>
    runProtocolSubcommand(
      'update',
      protocolBody({
        '--mission-id': requiredString(args, 'missionId'),
        '--session-key': requiredString(args, 'sessionKey'),
        '--summary': requiredString(args, 'summary'),
        ...(optionalString(args, 'phase') ? { '--phase': requiredString(args, 'phase') } : {}),
        ...(optionalString(args, 'eventType')
          ? { '--event-type': requiredString(args, 'eventType') }
          : {})
      })
    ),
  overlord_deliver_session: args =>
    runProtocolSubcommand('deliver', {
      flags: {
        '--mission-id': requiredString(args, 'missionId'),
        '--session-key': requiredString(args, 'sessionKey'),
        '--summary': requiredString(args, 'summary'),
        ...(args.noFileChanges === true ? { '--no-file-changes': true } : {}),
        ...(Array.isArray(args.changeRationales) ? { '--change-rationales-file': true } : {}),
        ...(Array.isArray(args.humanActions) ||
        Array.isArray(args.tradeoffsMade) ||
        Array.isArray(args.knownRisks) ||
        Array.isArray(args.deferredWork) ||
        Array.isArray(args.assumptions)
          ? {
              '--payload-json': JSON.stringify({
                deliveryReport: {
                  schemaVersion: 1,
                  agentReport: {
                    ...(Array.isArray(args.humanActions)
                      ? { humanActions: args.humanActions }
                      : {}),
                    ...(Array.isArray(args.tradeoffsMade)
                      ? { tradeoffsMade: args.tradeoffsMade }
                      : {}),
                    ...(Array.isArray(args.knownRisks) ? { knownRisks: args.knownRisks } : {}),
                    ...(Array.isArray(args.deferredWork)
                      ? { deferredWork: args.deferredWork }
                      : {}),
                    ...(Array.isArray(args.assumptions) ? { assumptions: args.assumptions } : {})
                  }
                }
              })
            }
          : {})
      },
      fileInputs: Array.isArray(args.changeRationales)
        ? { '--change-rationales-file': JSON.stringify(args.changeRationales) }
        : undefined
    })
};

const tools: ToolEntry[] = hostedMcpToolDefinitions.map(definition => {
  const handler = toolHandlers[definition.name];
  if (!handler) throw new Error(`Missing MCP tool handler: ${definition.name}`);
  return { ...definition, handler };
});

const extraHandlers = Object.keys(toolHandlers).filter(
  name => !hostedMcpToolDefinitions.some(definition => definition.name === name)
);
if (extraHandlers.length > 0) {
  throw new Error(`MCP tool handlers without catalog entries: ${extraHandlers.join(', ')}`);
}

function toolDefinitions(): ToolDefinition[] {
  return tools.map(({ handler: _handler, ...definition }) => definition);
}

function success(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function failure(id: JsonRpcId | undefined, error: JsonRpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

async function callTool(params: unknown): Promise<ToolCallResult> {
  if (!isRecord(params) || !isRecord(params.arguments)) {
    throw new Error('tools/call requires params.name and params.arguments');
  }
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
  try {
    return jsonText(await tool.handler(params.arguments));
  } catch (error) {
    return toolErrorText(error);
  }
}

function readResource(params: unknown): Record<string, unknown> {
  if (!isRecord(params) || typeof params.uri !== 'string') {
    throw new Error('resources/read requires params.uri');
  }
  const resource = readHostedMcpWidget(params.uri);
  if (!resource) throw new Error(`Unknown MCP resource: ${params.uri}`);
  return {
    contents: [
      {
        uri: resource.uri,
        name: resource.name,
        mimeType: resource.mimeType,
        text: resource.text,
        _meta: resource._meta
      }
    ]
  };
}

async function dispatch(request: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return failure(request.id, { code: -32600, message: 'Invalid JSON-RPC request' });
  }

  try {
    switch (request.method) {
      case 'initialize':
        return success(request.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: { name: 'overlord', version: '0.1.0' },
          instructions:
            'Overlord manages explicit user-authorized work. Resolve project identity before creating work, use read tools before writes, and call session lifecycle tools only when the user explicitly asks to begin, update, or deliver mission work.',
          capabilities: { tools: {}, resources: {} }
        });
      case 'notifications/initialized':
        return null;
      case 'ping':
        return success(request.id, {});
      case 'tools/list':
        return success(request.id, { tools: toolDefinitions() });
      case 'tools/call':
        return success(request.id, await callTool(request.params));
      case 'resources/list':
        return success(request.id, { resources: hostedMcpWidgetResources });
      case 'resources/read':
        return success(request.id, readResource(request.params));
      default:
        return failure(request.id, {
          code: -32601,
          message: `Method not found: ${request.method}`
        });
    }
  } catch (err) {
    return failure(request.id, {
      code: -32000,
      message: err instanceof Error ? err.message : 'MCP tool failed'
    });
  }
}

export function mcpServerInfo(req: Request): Record<string, unknown> {
  const resource = new URL(
    '/mcp',
    `${req.protocol}://${req.get('host') ?? 'localhost'}`
  ).toString();
  return {
    name: 'overlord',
    protocolVersion: MCP_PROTOCOL_VERSION,
    endpoint: resource,
    capabilities: { tools: toolDefinitions(), resources: hostedMcpWidgetResources },
    instructions:
      'Resolve project identity before creating work. Use read tools before writes. Mission and session writes require explicit user intent.'
  };
}

export async function handleMcpPost(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = req.body;
    const requests = Array.isArray(body) ? body : [body];
    const responses: Array<Record<string, unknown>> = [];
    for (const item of requests) {
      const response = await dispatch(isRecord(item) ? item : {});
      if (response) responses.push(response);
    }
    if (Array.isArray(body)) {
      res.json(responses);
      return;
    }
    res.json(responses[0] ?? { jsonrpc: '2.0', result: null });
  } catch (err) {
    next(err);
  }
}
