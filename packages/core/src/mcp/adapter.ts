import { isEngineError } from '../errors.js';
import type { Tool } from '../tools/types.js';
import type { JsonSchema, RiskLevel } from '../types.js';
import type { CallToolResult, McpContent, McpTool } from './types.js';

export interface McpToolCaller {
  (name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export function mcpToolToTool(serverName: string, tool: McpTool, caller: McpToolCaller): Tool {
  const baseDescription = tool.description ?? tool.annotations?.title ?? tool.name;
  return {
    name: `mcp__${sanitize(serverName)}__${sanitize(tool.name)}`,
    description: `${baseDescription}\n\n（来自 MCP 服务器 ${serverName}）`,
    parameters: toJsonSchema(tool),
    risk: toolRisk(tool),
    footprint: () => ({ access: 'execute', command: `mcp:${serverName}:${tool.name}` }),
    execute: async (args) => {
      const summary = `调用 MCP 工具 ${serverName}:${tool.name}`;
      try {
        const result = await caller(tool.name, args);
        return {
          ok: result.isError !== true,
          content: serializeContent(result.content),
          summary,
        };
      } catch (error) {
        if (isEngineError(error) && error.code === 'ENGINE_ABORTED') throw error;
        return {
          ok: false,
          content: isEngineError(error) ? error.userMessage : error instanceof Error ? error.message : String(error),
          summary,
        };
      }
    },
  };
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toJsonSchema(tool: McpTool): JsonSchema {
  const { properties, required, ...rest } = tool.inputSchema;
  return {
    ...rest,
    type: 'object',
    properties: properties ?? {},
    ...(Array.isArray(required) && required.every((item) => typeof item === 'string') ? { required } : {}),
  };
}

function toolRisk(tool: McpTool): RiskLevel {
  if (tool.annotations?.destructiveHint === true) return 'high';
  if (tool.annotations?.readOnlyHint === true) return 'low';
  return 'medium';
}

function serializeContent(content: McpContent[]): string {
  if (content.length === 0) return '（无返回内容）';
  return content.map(contentToText).join('\n\n');
}

function contentToText(content: McpContent): string {
  if (content.type === 'text') return content.text;
  if (content.type === 'image') return `[图片: ${content.mimeType}, base64 ${content.data.length} 字符]`;
  return content.resource.text ?? `[资源: ${content.resource.uri}]`;
}
