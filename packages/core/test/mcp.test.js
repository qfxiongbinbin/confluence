import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EngineError,
  HttpTransport,
  McpClient,
  StdioTransport,
  mcpToolToTool,
} from '../dist/index.js';

const mockServerSource = String.raw`
import { createInterface } from 'node:readline';

const version = process.argv[2] ?? '2026-07-28';
const mode = process.argv[3] ?? 'normal';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  const message = JSON.parse(line);
  if (!('id' in message)) continue;
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-stdio', version: '1.0.0' },
    });
  } else if (message.method === 'tools/list') {
    respond(message.id, {
      tools: [{ name: 'echo', description: '回显文本', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
    });
  } else if (message.method === 'tools/call' && mode !== 'timeout') {
    respond(message.id, { content: [{ type: 'text', text: 'stdio:' + message.params.arguments.text }] });
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
`;

function createMockStdioServer(version = '2026-07-28', mode = 'normal') {
  const directory = mkdtempSync(join(tmpdir(), 'cf-mcp-'));
  const script = join(directory, 'server.mjs');
  writeFileSync(script, mockServerSource);
  return new StdioTransport({ command: process.execPath, args: [script, version, mode] });
}

async function startHttpServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    request.setEncoding('utf8');
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    requests.push({ message, sessionId: request.headers['mcp-session-id'] });

    if (message.method === 'initialize') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'session-42' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2026-07-28',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-http', version: '1.0.0' },
          },
        }),
      );
      return;
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === 'tools/list') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: [{ name: 'stream', inputSchema: { type: 'object', properties: {} } }] },
        }),
      );
      return;
    }
    if (message.method === 'tools/call') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: message\n');
      response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'sse-ok' }] } })}\n\n`);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, requests, url: `http://127.0.0.1:${address.port}/mcp` };
}

test('stdio transport 完成 initialize、tools/list 与 tools/call', async (t) => {
  const client = new McpClient({ name: 'stdio', transport: createMockStdioServer() });
  t.after(() => client.close());
  await client.start();
  assert.equal(client.protocolVersion, '2026-07-28');
  assert.deepEqual(client.serverInfo, { name: 'mock-stdio', version: '1.0.0' });
  const tools = await client.listTools();
  assert.equal(tools[0].name, 'echo');
  const result = await client.callTool('echo', { text: '你好' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'stdio:你好' }]);
});

test('HTTP transport 复用 session header 并解析 SSE', async (t) => {
  const mock = await startHttpServer();
  t.after(() => mock.server.close());
  const client = new McpClient({ name: 'http', transport: new HttpTransport({ url: mock.url }) });
  t.after(() => client.close());
  await client.start();
  const tools = await client.listTools();
  assert.equal(tools[0].name, 'stream');
  const result = await client.callTool('stream', {});
  assert.deepEqual(result.content, [{ type: 'text', text: 'sse-ok' }]);
  const followUpRequests = mock.requests.filter((item) => item.message.method !== 'initialize');
  assert.ok(followUpRequests.length >= 2);
  assert.ok(followUpRequests.every((item) => item.sessionId === 'session-42'));
});

test('客户端宽容接受旧 MCP 协议版本', async (t) => {
  const client = new McpClient({ name: 'old', transport: createMockStdioServer('2025-11-25') });
  t.after(() => client.close());
  await client.start();
  assert.equal(client.protocolVersion, '2025-11-25');
});

test('adapter 将 isError 映射为 ok=false', async () => {
  const tool = mcpToolToTool(
    'demo',
    { name: 'fail', inputSchema: { type: 'object', properties: {} } },
    async () => ({ content: [{ type: 'text', text: '失败详情' }], isError: true }),
  );
  const result = await tool.execute({}, {});
  assert.equal(result.ok, false);
  assert.equal(result.content, '失败详情');
});

test('tools/call 超时抛 MCP_TIMEOUT EngineError', async (t) => {
  const client = new McpClient({
    name: 'timeout',
    transport: createMockStdioServer('2026-07-28', 'timeout'),
    callTimeoutMs: 30,
  });
  t.after(() => client.close());
  await client.start();
  await assert.rejects(
    () => client.callTool('echo', { text: 'never' }),
    (error) => error instanceof EngineError && error.code === 'MCP_TIMEOUT',
  );
});

test('不存在的 stdio command 映射为 MCP_SERVER_START_FAILED', async () => {
  const client = new McpClient({
    name: 'missing',
    transport: new StdioTransport({ command: `cf-mcp-not-found-${Date.now()}` }),
  });
  await assert.rejects(
    () => client.start(),
    (error) => error instanceof EngineError && error.code === 'MCP_SERVER_START_FAILED',
  );
});

test('adapter 按 annotations 映射 risk 并清理工具名', () => {
  const base = { name: 'tool.name', inputSchema: { type: 'object', properties: {} } };
  const destructive = mcpToolToTool('server name', { ...base, annotations: { destructiveHint: true } }, async () => ({ content: [] }));
  const readOnly = mcpToolToTool('server', { ...base, annotations: { readOnlyHint: true } }, async () => ({ content: [] }));
  const normal = mcpToolToTool('server', base, async () => ({ content: [] }));
  assert.equal(destructive.risk, 'high');
  assert.equal(readOnly.risk, 'low');
  assert.equal(normal.risk, 'medium');
  assert.equal(destructive.name, 'mcp__server_name__tool_name');
});

test('adapter 序列化 text、image 与 resource 且不展开 base64', async () => {
  const tool = mcpToolToTool(
    'media',
    { name: 'mixed', inputSchema: { type: 'object', properties: {} } },
    async () => ({
      content: [
        { type: 'text', text: '正文' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        { type: 'resource', resource: { uri: 'file:///note.txt', text: '资源正文' } },
      ],
    }),
  );
  const result = await tool.execute({}, {});
  assert.equal(result.ok, true);
  assert.equal(result.content, '正文\n\n[图片: image/png, base64 8 字符]\n\n资源正文');
  assert.doesNotMatch(result.content, /aGVsbG8=/);
});
