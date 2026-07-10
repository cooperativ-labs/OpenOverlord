import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { hostedMcpToolDefinitions } from '../mcp/tool-catalog.ts';
import { hostedMcpWidgetResources, readHostedMcpWidget } from '../mcp/widgets.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

type ToolContract = {
  name: string;
  required: string[];
  properties: string[];
};

function normalizeTools(tools: Array<Record<string, any>>): ToolContract[] {
  return tools
    .map(tool => {
      const inputSchema = tool.inputSchema ?? {};
      return {
        name: String(tool.name),
        required: [...(inputSchema.required ?? [])].sort(),
        properties: Object.keys(inputSchema.properties ?? {}).sort()
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function hostedToolContracts(): ToolContract[] {
  return normalizeTools(hostedMcpToolDefinitions);
}

function encodeMcpMessage(message: Record<string, unknown>): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

function parseMcpMessages(buffer: Buffer): Array<Record<string, any>> {
  const messages: Array<Record<string, any>> = [];
  let remaining = buffer;
  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = remaining.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    assert.ok(match, `missing Content-Length in ${header}`);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (remaining.length < bodyEnd) break;
    messages.push(JSON.parse(remaining.subarray(bodyStart, bodyEnd).toString('utf8')));
    remaining = remaining.subarray(bodyEnd);
  }
  return messages;
}

async function localToolContracts(scriptPath: string): Promise<ToolContract[]> {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));

  child.stdin.write(encodeMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  child.stdin.end();

  const exitCode = await new Promise<number | null>(resolve => {
    child.on('exit', resolve);
  });

  assert.equal(
    exitCode,
    0,
    `${scriptPath} failed: ${Buffer.concat(stderrChunks).toString('utf8')}`
  );
  const messages = parseMcpMessages(Buffer.concat(stdoutChunks));
  const response = messages.find(message => message.id === 1);
  assert.ok(response, `${scriptPath} did not return a tools/list response`);
  assert.ifError(response.error);
  return normalizeTools(response.result.tools);
}

test('local MCP bridge tools stay in sync with hosted MCP registry', async () => {
  const expected = hostedToolContracts();
  const scripts = [
    'connectors/adapters/codex/scripts/overlord-mcp.mjs',
    'connectors/adapters/cursor/scripts/overlord-mcp.mjs',
    'connectors/adapters/antigravity/scripts/overlord-mcp.mjs'
  ];

  for (const relativePath of scripts) {
    assert.deepEqual(await localToolContracts(path.join(repoRoot, relativePath)), expected);
  }
});

test('hosted MCP tool metadata is publication-ready', () => {
  for (const tool of hostedMcpToolDefinitions) {
    assert.match(tool.description, /^Use this /, `${tool.name} has a scoped tool description`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} has an input object schema`);
    assert.equal(tool.outputSchema.type, 'object', `${tool.name} has an output object schema`);
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} labels reads`);
    assert.equal(
      typeof tool.annotations?.destructiveHint,
      'boolean',
      `${tool.name} labels destructive behavior`
    );
    assert.equal(
      typeof tool.annotations?.openWorldHint,
      'boolean',
      `${tool.name} labels external publication behavior`
    );
  }
});

test('hosted MCP widget resources are self-contained and readable', () => {
  assert.deepEqual(hostedMcpWidgetResources.map(resource => resource.uri).sort(), [
    'ui://overlord/file-changes.html',
    'ui://overlord/mission-list.html',
    'ui://overlord/objective-viewer.html',
    'ui://overlord/project-selector.html'
  ]);
  for (const resource of hostedMcpWidgetResources) {
    const loaded = readHostedMcpWidget(resource.uri);
    assert.ok(loaded);
    assert.equal(loaded.mimeType, 'text/html;profile=mcp-app');
    assert.match(loaded.text, /ui\/notifications\/tool-result/);
    assert.doesNotMatch(loaded.text, /<iframe/i);
  }
});
