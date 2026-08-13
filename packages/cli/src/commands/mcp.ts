import { createMcpClient, type McpServerConfig } from '@confluence/core';
import type { AppConfig } from '../config.js';
import { err, heading, info, kv, line, ok, table } from '../ui.js';
import { flag } from './provider.js';

export async function mcpCommand(cfg: AppConfig, args: string[]): Promise<number> {
  const [sub, name] = args;
  if (sub === 'ls') {
    const rows = cfg.listMcpServers().map((server) => [
      server.name,
      server.command ? 'stdio' : 'http',
      server.command ? [server.command, ...(server.args ?? [])].join(' ') : (server.url ?? ''),
      server.disabled ? '已禁用' : '已启用',
    ]);
    heading(`MCP 服务器（${rows.length} 个）`);
    table(rows, ['名称', '类型', '命令 / URL', '状态']);
    if (rows.length === 0) info('尚未配置 MCP 服务器。');
    return 0;
  }

  if (sub === 'add') {
    if (!name) return usage('用法：cf mcp add <name> --command <cmd> [--arg <arg>...] 或 --url <url>');
    const command = flag(args, '--command');
    const url = flag(args, '--url');
    if (!command && !url) return usage('必须提供 --command 或 --url。');
    const timeoutValue = flag(args, '--timeout');
    const timeoutMs = timeoutValue === undefined ? undefined : Number(timeoutValue);
    if (timeoutValue !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs! <= 0)) {
      return usage('--timeout 必须是大于 0 的毫秒数。');
    }
    const headers = parseHeaders(multiFlag(args, '--header'));
    if (!headers.ok) return usage(headers.error);

    const server: McpServerConfig = {
      name,
      ...(command ? { command, args: multiFlag(args, '--arg') } : {}),
      ...(url ? { url } : {}),
      ...(headers.value ? { headers: headers.value } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    cfg.upsertMcpServer(server);
    ok(`已保存 MCP 服务器 ${name}`);
    return 0;
  }

  if (sub === 'rm') {
    if (!name) return usage('用法：cf mcp rm <name>');
    cfg.removeMcpServer(name);
    ok(`已删除 MCP 服务器 ${name}`);
    return 0;
  }

  if (sub === 'test') {
    if (!name) return usage('用法：cf mcp test <name>');
    const server = cfg.getMcpServer(name);
    if (!server) {
      err(`未配置 MCP 服务器 ${name}`);
      return 1;
    }
    let client: ReturnType<typeof createMcpClient> | undefined;
    try {
      client = createMcpClient(server);
      await client.start();
      const tools = await client.listTools();
      heading(`MCP 测试：${name}`);
      kv('服务器', client.serverInfo ? `${client.serverInfo.name} ${client.serverInfo.version}` : '未提供');
      kv('协议版本', client.protocolVersion ?? '未知');
      kv('工具数量', String(tools.length));
      for (const tool of tools) line(`  ${tool.name}  risk=${toolRisk(tool.annotations)}`);
      ok(`${name} 连接正常`);
      return 0;
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return 1;
    } finally {
      if (client) await client.close().catch(() => {});
    }
  }

  return usage();
}

function multiFlag(args: string[], name: string): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg === name && args[index + 1]) values.push(args[index + 1]!);
  });
  return values;
}

function parseHeaders(values: string[]): { ok: true; value?: Record<string, string> } | { ok: false; error: string } {
  if (values.length === 0) return { ok: true };
  const headers: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0) return { ok: false, error: `header 格式错误：${value}，应为 K=V。` };
    headers[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return { ok: true, value: headers };
}

function toolRisk(annotations: { destructiveHint?: boolean; readOnlyHint?: boolean } | undefined): string {
  if (annotations?.destructiveHint) return 'high';
  if (annotations?.readOnlyHint) return 'low';
  return 'medium';
}

function usage(message?: string): number {
  if (message) err(message);
  line('用法：');
  line('  cf mcp ls');
  line('  cf mcp add <name> --command <cmd> [--arg <arg>...] [--timeout <ms>]');
  line('  cf mcp add <name> --url <url> [--header K=V...] [--timeout <ms>]');
  line('  cf mcp rm <name>');
  line('  cf mcp test <name>');
  return message ? 1 : 0;
}
