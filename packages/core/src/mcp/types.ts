export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = '2026-07-28';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface ImplementationInfo {
  name: string;
  version: string;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  [k: string]: unknown;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: ImplementationInfo;
  instructions?: string;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  annotations?: McpToolAnnotations;
}

export interface ListToolsResult {
  tools: McpTool[];
}

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface McpResourceContent {
  type: 'resource';
  resource: { uri: string; mimeType?: string; text?: string; blob?: string };
}

export type McpContent = McpTextContent | McpImageContent | McpResourceContent;

export interface CallToolResult {
  content: McpContent[];
  isError?: boolean;
}
