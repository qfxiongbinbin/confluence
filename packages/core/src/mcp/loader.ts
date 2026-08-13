import { EngineError, toEngineError } from '../errors.js';
import type { Tool } from '../tools/types.js';
import { mcpToolToTool } from './adapter.js';
import { McpClient } from './client.js';
import { HttpTransport } from './http.js';
import { StdioTransport } from './stdio.js';

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  disabled?: boolean;
}

export function createMcpClient(config: McpServerConfig, opts: { fetchImpl?: typeof fetch } = {}): McpClient {
  if (config.command) {
    return new McpClient({
      name: config.name,
      transport: new StdioTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      }),
      ...(config.timeoutMs === undefined
        ? {}
        : { initTimeoutMs: config.timeoutMs, callTimeoutMs: config.timeoutMs }),
    });
  }
  if (config.url) {
    return new McpClient({
      name: config.name,
      transport: new HttpTransport({
        url: config.url,
        headers: config.headers,
        fetchImpl: opts.fetchImpl,
        timeoutMs: config.timeoutMs,
      }),
    });
  }
  throw new EngineError('MCP_CONFIG_INVALID', { name: config.name, detail: 'command 与 url 均未配置' });
}

export interface McpLoadResult {
  tools: Tool[];
  clients: McpClient[];
  failures: { name: string; error: EngineError }[];
}

export async function loadMcpTools(
  configs: McpServerConfig[],
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<McpLoadResult> {
  const results = await Promise.all(
    configs.filter((config) => !config.disabled).map(async (config) => {
      let client: McpClient | undefined;
      try {
        client = createMcpClient(config, opts);
        await client.start();
        const remoteTools = await client.listTools();
        const tools = remoteTools.map((tool) =>
          mcpToolToTool(config.name, tool, (name, args) => client!.callTool(name, args)),
        );
        return { ok: true as const, client, tools };
      } catch (error) {
        if (client) await client.close().catch(() => {});
        return {
          ok: false as const,
          failure: { name: config.name, error: toEngineError(error, { mcp: config.name }) },
        };
      }
    }),
  );

  const loaded: McpLoadResult = { tools: [], clients: [], failures: [] };
  for (const result of results) {
    if (result.ok) {
      loaded.clients.push(result.client);
      loaded.tools.push(...result.tools);
    } else loaded.failures.push(result.failure);
  }
  return loaded;
}
