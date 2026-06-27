#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const OVLD_BIN = process.env.OVLD_BIN?.trim() || 'ovld';
const PROTOCOL_VERSION = '2025-06-18';
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
        AGENT_IDENTIFIER: process.env.AGENT_IDENTIFIER ?? 'cursor'
      },
      maxBuffer: 20 * 1024 * 1024
    });
    const data = stdout.trim() ? JSON.parse(stdout) : {};
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
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
          serverInfo: { name: 'overlord-cursor', version: '0.2.5' }
        }
      });
      continue;
    }
    if (message.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: 'attach',
              description: 'Attach to an Overlord mission.',
              inputSchema: {
                type: 'object',
                properties: { mission_id: { type: 'string' } },
                required: ['mission_id']
              }
            },
            {
              name: 'update',
              description: 'Post a progress update.',
              inputSchema: {
                type: 'object',
                properties: {
                  session_key: { type: 'string' },
                  mission_id: { type: 'string' },
                  summary: { type: 'string' },
                  phase: { type: 'string' }
                },
                required: ['session_key', 'mission_id', 'summary']
              }
            },
            {
              name: 'deliver',
              description: 'Deliver completed work.',
              inputSchema: {
                type: 'object',
                properties: {
                  session_key: { type: 'string' },
                  mission_id: { type: 'string' },
                  summary: { type: 'string' }
                },
                required: ['session_key', 'mission_id', 'summary']
              }
            }
          ]
        }
      });
      continue;
    }
    if (message.method === 'tools/call') {
      const toolName = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (toolName === 'attach') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: await runProtocol('attach', { 'mission-id': args.mission_id })
        });
      } else if (toolName === 'update') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: await runProtocol('update', {
            'session-key': args.session_key,
            'mission-id': args.mission_id,
            summary: args.summary,
            phase: args.phase && String(args.phase).trim() ? String(args.phase).trim() : 'execute'
          })
        });
      } else if (toolName === 'deliver') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: await runProtocol('deliver', {
            'session-key': args.session_key,
            'mission-id': args.mission_id,
            summary: args.summary
          })
        });
      } else {
        send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` }
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
