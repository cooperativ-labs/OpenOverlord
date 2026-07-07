import type { NextFunction, Request, Response } from 'express';

import type { ProtocolRequestBody } from '../backend/protocol.ts';
import { runProtocolSubcommand } from '../backend/protocol.ts';

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

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
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
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
}

const stringProperty = (description: string): Record<string, unknown> => ({
  type: 'string',
  description
});

const tools: ToolEntry[] = [
  {
    name: 'overlord_resolve_project',
    title: 'Resolve Overlord project',
    description:
      'Resolve a project by id, slug, name, or linked repository directory metadata exposed to the MCP client.',
    inputSchema: objectSchema({
      projectId: stringProperty('Explicit Overlord project id, slug, or project name.'),
      directory: stringProperty(
        'Optional repository directory path when the MCP client can expose one with .overlord/project.json.'
      )
    }),
    annotations: { readOnlyHint: true },
    handler: args =>
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
      )
  },
  {
    name: 'overlord_search_missions',
    title: 'Search Overlord missions',
    description: 'Search missions in the OAuth-bound workspace.',
    inputSchema: objectSchema({
      query: stringProperty('Search query text.'),
      status: stringProperty('Comma-separated status types, such as draft,execute,review.'),
      projectId: stringProperty('Optional project id, slug, or name.'),
      limit: {
        type: 'number',
        description: 'Maximum result count. Defaults to 25.'
      }
    }),
    annotations: { readOnlyHint: true },
    handler: args =>
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
      )
  },
  {
    name: 'overlord_create_mission',
    title: 'Create Overlord mission',
    description:
      'Create a mission in an explicit project. Hosted MCP never chooses a default project implicitly.',
    inputSchema: objectSchema(
      {
        projectId: stringProperty('Required Overlord project id, slug, or name.'),
        objective: stringProperty('Initial objective text.'),
        title: stringProperty('Optional mission title.'),
        resourceKey: stringProperty('Optional logical project resource key for the objective.')
      },
      ['projectId', 'objective']
    ),
    handler: args =>
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
      )
  },
  {
    name: 'overlord_load_mission_context',
    title: 'Load mission context',
    description:
      'Load structured mission context, objectives, history, artifacts, and shared context.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id such as coo:150.')
      },
      ['missionId']
    ),
    annotations: { readOnlyHint: true },
    handler: args =>
      runProtocolSubcommand(
        'load-context',
        protocolBody({ '--mission-id': requiredString(args, 'missionId') })
      )
  },
  {
    name: 'overlord_add_objectives',
    title: 'Add objectives',
    description: 'Append one or more draft objectives to an existing mission.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        objectives: {
          type: 'array',
          description: 'Objective objects with objective text and optional title/resourceKey.',
          items: objectSchema({
            objective: stringProperty('Objective text.'),
            title: stringProperty('Optional objective title.'),
            resourceKey: stringProperty('Optional logical project resource key.')
          })
        }
      },
      ['missionId', 'objectives']
    ),
    handler: args => {
      if (!Array.isArray(args.objectives)) {
        throw new Error('objectives must be an array');
      }
      return runProtocolSubcommand('add-objectives', {
        flags: { '--mission-id': requiredString(args, 'missionId'), '--objectives-file': true },
        fileInputs: { '--objectives-file': JSON.stringify(args.objectives) }
      });
    }
  },
  {
    name: 'overlord_attach_session',
    title: 'Attach to mission',
    description: 'Attach an MCP-hosted agent session to a mission before update/ask/deliver.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        agent: stringProperty('Agent identifier. Defaults to hosted-mcp.'),
        model: stringProperty('Optional model identifier.')
      },
      ['missionId']
    ),
    handler: args =>
      runProtocolSubcommand(
        'attach',
        protocolBody({
          '--mission-id': requiredString(args, 'missionId'),
          '--agent': optionalString(args, 'agent') ?? 'hosted-mcp',
          ...(optionalString(args, 'model') ? { '--model': requiredString(args, 'model') } : {})
        })
      )
  },
  {
    name: 'overlord_update_session',
    title: 'Update mission session',
    description: 'Post an update, alert, decision, or discussion summary for an attached session.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        sessionKey: stringProperty('Session key returned by overlord_attach_session.'),
        summary: stringProperty('Update text.'),
        phase: stringProperty('Optional protocol phase.'),
        eventType: stringProperty('Optional event type. Defaults to update.')
      },
      ['missionId', 'sessionKey', 'summary']
    ),
    handler: args =>
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
      )
  },
  {
    name: 'overlord_deliver_session',
    title: 'Deliver mission session',
    description:
      'Deliver an attached session with explicit summary and optional change rationales.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        sessionKey: stringProperty('Session key returned by overlord_attach_session.'),
        summary: stringProperty('Delivery summary.'),
        noFileChanges: {
          type: 'boolean',
          description: 'Set true when the MCP run changed no files.'
        },
        changeRationales: {
          type: 'array',
          description: 'Explicit change rationale objects, if files were changed.'
        }
      },
      ['missionId', 'sessionKey', 'summary']
    ),
    handler: args =>
      runProtocolSubcommand('deliver', {
        flags: {
          '--mission-id': requiredString(args, 'missionId'),
          '--session-key': requiredString(args, 'sessionKey'),
          '--summary': requiredString(args, 'summary'),
          ...(args.noFileChanges === true ? { '--no-file-changes': true } : {}),
          ...(Array.isArray(args.changeRationales) ? { '--change-rationales-file': true } : {})
        },
        fileInputs: Array.isArray(args.changeRationales)
          ? { '--change-rationales-file': JSON.stringify(args.changeRationales) }
          : undefined
      })
  }
];

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
  return jsonText(await tool.handler(params.arguments));
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
          capabilities: { tools: {} }
        });
      case 'notifications/initialized':
        return null;
      case 'ping':
        return success(request.id, {});
      case 'tools/list':
        return success(request.id, { tools: toolDefinitions() });
      case 'tools/call':
        return success(request.id, await callTool(request.params));
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
    capabilities: { tools: toolDefinitions() }
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
