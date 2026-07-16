#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OVLD_BIN = process.env.OVLD_BIN?.trim() || 'ovld';
const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_AGENT = 'cursor';
let buffer = Buffer.alloc(0);

function send(message) {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  process.stdout.write(Buffer.concat([header, body]));
}

function parseMessages(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  const messages = [];
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const headerText = buffer.subarray(0, headerEnd).toString('utf8');
    const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) throw new Error('Missing Content-Length header');
    const contentLength = Number(lengthMatch[1]);
    const totalLength = headerEnd + 4 + contentLength;
    if (buffer.length < totalLength) break;
    const body = buffer.subarray(headerEnd + 4, totalLength).toString('utf8');
    buffer = buffer.subarray(totalLength);
    messages.push(JSON.parse(body));
  }
  return messages;
}

async function runProtocol(subcommand, args = {}) {
  const flags = Object.entries(args).flatMap(([key, value]) => {
    if (value === undefined || value === null) return [];
    if (typeof value === 'boolean') return value ? [`--${key}`] : [];
    if (Array.isArray(value)) return [`--${key}`, JSON.stringify(value)];
    if (typeof value === 'object') return [`--${key}-json`, JSON.stringify(value)];
    return [`--${key}`, String(value)];
  });

  try {
    const { stdout } = await execFileAsync(OVLD_BIN, ['protocol', subcommand, ...flags], {
      env: {
        ...process.env,
        AGENT_IDENTIFIER: process.env.AGENT_IDENTIFIER ?? DEFAULT_AGENT
      },
      maxBuffer: 20 * 1024 * 1024
    });
    const data = stdout.trim() ? JSON.parse(stdout) : {};
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      structuredContent: data
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

function objectSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
}

function stringProperty(description) {
  return { type: 'string', description };
}

const tools = [
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
    })
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
    })
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
    )
  },
  {
    name: 'overlord_load_mission_context',
    title: 'Load mission context',
    description:
      'Load structured mission context, objectives, history, artifacts, and shared context.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id such as coo:150.'),
        executionTargetId: stringProperty(
          'Optional local execution target id for resolving sibling project resource paths.'
        )
      },
      ['missionId']
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
    )
  },
  {
    name: 'overlord_attach_session',
    title: 'Attach to mission',
    description: 'Attach an MCP-hosted agent session to a mission before update/ask/deliver.',
    inputSchema: objectSchema(
      {
        missionId: stringProperty('Mission UUID or workspace display id.'),
        agent: stringProperty(`Agent identifier. Defaults to ${DEFAULT_AGENT}.`),
        model: stringProperty('Optional model identifier.'),
        executionTargetId: stringProperty(
          'Optional local execution target id for resolving sibling project resource paths.'
        )
      },
      ['missionId']
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
    )
  }
];

function optionalString(args, name) {
  const value = args?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredString(args, name) {
  const value = optionalString(args, name);
  if (!value) throw new Error(`Missing required argument: ${name}`);
  return value;
}

function callOverlordTool(name, args) {
  if (name === 'overlord_resolve_project') {
    return runProtocol('discover-project', {
      ...(optionalString(args, 'projectId')
        ? { 'project-id': requiredString(args, 'projectId') }
        : {}),
      ...(optionalString(args, 'directory') ? { directory: requiredString(args, 'directory') } : {})
    });
  }
  if (name === 'overlord_search_missions') {
    return runProtocol('search-missions', {
      ...(optionalString(args, 'query') ? { query: requiredString(args, 'query') } : {}),
      ...(optionalString(args, 'status') ? { status: requiredString(args, 'status') } : {}),
      ...(optionalString(args, 'projectId')
        ? { 'project-id': requiredString(args, 'projectId') }
        : {}),
      ...(typeof args.limit === 'number' && Number.isFinite(args.limit)
        ? { limit: String(Math.trunc(args.limit)) }
        : {})
    });
  }
  if (name === 'overlord_create_mission') {
    return runProtocol('create', {
      'project-id': requiredString(args, 'projectId'),
      objective: requiredString(args, 'objective'),
      ...(optionalString(args, 'title') ? { title: requiredString(args, 'title') } : {}),
      ...(optionalString(args, 'resourceKey')
        ? { resource: requiredString(args, 'resourceKey') }
        : {})
    });
  }
  if (name === 'overlord_load_mission_context') {
    return runProtocol('load-context', {
      'mission-id': requiredString(args, 'missionId'),
      ...(optionalString(args, 'executionTargetId')
        ? { 'execution-target-id': requiredString(args, 'executionTargetId') }
        : {})
    });
  }
  if (name === 'overlord_add_objectives') {
    if (!Array.isArray(args.objectives)) throw new Error('objectives must be an array');
    return runProtocol('add-objectives', {
      'mission-id': requiredString(args, 'missionId'),
      'objectives-json': args.objectives
    });
  }
  if (name === 'overlord_attach_session') {
    return runProtocol('attach', {
      'mission-id': requiredString(args, 'missionId'),
      agent: optionalString(args, 'agent') ?? DEFAULT_AGENT,
      ...(optionalString(args, 'model') ? { model: requiredString(args, 'model') } : {}),
      ...(optionalString(args, 'executionTargetId')
        ? { 'execution-target-id': requiredString(args, 'executionTargetId') }
        : {})
    });
  }
  if (name === 'overlord_update_session') {
    return runProtocol('update', {
      'mission-id': requiredString(args, 'missionId'),
      'session-key': requiredString(args, 'sessionKey'),
      summary: requiredString(args, 'summary'),
      ...(optionalString(args, 'phase') ? { phase: requiredString(args, 'phase') } : {}),
      ...(optionalString(args, 'eventType')
        ? { 'event-type': requiredString(args, 'eventType') }
        : {})
    });
  }
  if (name === 'overlord_deliver_session') {
    return runProtocol('deliver', {
      'mission-id': requiredString(args, 'missionId'),
      'session-key': requiredString(args, 'sessionKey'),
      summary: requiredString(args, 'summary'),
      ...(args.noFileChanges === true ? { 'no-file-changes': true } : {}),
      ...(Array.isArray(args.changeRationales)
        ? { 'change-rationales-json': args.changeRationales }
        : {})
    });
  }
  if (name === 'attach') {
    return runProtocol('attach', { 'mission-id': args.mission_id });
  }
  if (name === 'update') {
    return runProtocol('update', {
      'session-key': args.session_key,
      'mission-id': args.mission_id,
      summary: args.summary,
      phase: args.phase && String(args.phase).trim() ? String(args.phase).trim() : 'execute'
    });
  }
  if (name === 'deliver') {
    return runProtocol('deliver', {
      'session-key': args.session_key,
      'mission-id': args.mission_id,
      summary: args.summary
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

process.stdin.on('data', async chunk => {
  for (const message of parseMessages(chunk)) {
    if (!message || typeof message !== 'object' || !('id' in message)) continue;
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'overlord-cursor', version: '0.3.3' }
        }
      });
      continue;
    }
    if (message.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools }
      });
      continue;
    }
    if (message.method === 'tools/call') {
      const toolName = message.params?.name;
      const args = message.params?.arguments ?? {};
      try {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: await callOverlordTool(toolName, args)
        });
      } catch (error) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: error instanceof Error ? error.message : String(error) }
        });
      }
      continue;
    }
    if (message.method === 'ping') {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      continue;
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    });
  }
});

process.stdin.resume();
