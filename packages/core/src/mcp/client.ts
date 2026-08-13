import { EngineError, isEngineError, type ErrorCode } from '../errors.js';
import { JsonRpcResponseError, PendingMap, createNotification } from './jsonrpc.js';
import { McpInvalidResponseError, type McpTransport } from './transport.js';
import {
  LATEST_PROTOCOL_VERSION,
  type CallToolResult,
  type ImplementationInfo,
  type InitializeResult,
  type McpContent,
  type McpTool,
} from './types.js';

export interface McpClientOptions {
  name: string;
  transport: McpTransport;
  initTimeoutMs?: number;
  callTimeoutMs?: number;
  clientInfo?: ImplementationInfo;
}

type ClientState = 'idle' | 'starting' | 'initializing' | 'running' | 'closing' | 'closed';

export class McpClient {
  private readonly name: string;
  private readonly transport: McpTransport;
  private readonly initTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly clientInfo: ImplementationInfo;
  private readonly pending: PendingMap;
  private state: ClientState = 'idle';
  private negotiatedProtocolVersion?: string;
  private connectedServerInfo?: ImplementationInfo;
  private toolsCache?: McpTool[];

  constructor(options: McpClientOptions) {
    this.name = options.name;
    this.transport = options.transport;
    this.initTimeoutMs = options.initTimeoutMs ?? 30_000;
    this.callTimeoutMs = options.callTimeoutMs ?? 120_000;
    this.clientInfo = options.clientInfo ?? { name: 'confluence', version: '0.1.0' };
    this.pending = new PendingMap({
      onNotification: (notification) => {
        if (notification.method === 'notifications/tools/list_changed') this.toolsCache = undefined;
      },
    });
    this.transport.onMessage = (message) => {
      this.pending.handleMessage(message);
    };
    this.transport.onError = (error) => this.handleTransportError(error);
  }

  get protocolVersion(): string | undefined {
    return this.negotiatedProtocolVersion;
  }

  get serverInfo(): ImplementationInfo | undefined {
    return this.connectedServerInfo;
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;
    if (this.state !== 'idle') {
      throw new EngineError('MCP_SERVER_START_FAILED', { name: this.name, detail: `客户端状态为 ${this.state}` });
    }

    this.state = 'starting';
    try {
      await this.transport.start();
    } catch (error) {
      this.state = 'closed';
      throw this.wrapError('MCP_SERVER_START_FAILED', error, { detail: this.errorDetail(error) });
    }

    this.state = 'initializing';
    try {
      const raw = await this.request(
        'initialize',
        { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
        this.initTimeoutMs,
        'MCP_INIT_FAILED',
      );
      const initialized = this.parseInitializeResult(raw);
      this.negotiatedProtocolVersion = initialized.protocolVersion;
      this.connectedServerInfo = initialized.serverInfo;
      this.transport.send(createNotification('notifications/initialized'));
      this.state = 'running';
    } catch (error) {
      this.state = 'closed';
      await this.transport.close().catch(() => {});
      if (isEngineError(error)) throw error;
      throw this.wrapError('MCP_INIT_FAILED', error, { detail: this.errorDetail(error) });
    }
  }

  async listTools(): Promise<McpTool[]> {
    this.ensureRunning();
    if (this.toolsCache) return this.toolsCache;
    const raw = await this.request('tools/list', {}, this.callTimeoutMs, 'MCP_TOOL_CALL_FAILED');
    if (!isRecord(raw) || !Array.isArray(raw.tools) || !raw.tools.every(isMcpTool)) {
      throw this.invalidResponse('tools/list 返回格式不正确。');
    }
    this.toolsCache = raw.tools;
    return raw.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.ensureRunning();
    const raw = await this.request('tools/call', { name, arguments: args }, this.callTimeoutMs, 'MCP_TOOL_CALL_FAILED', {
      tool: name,
    });
    if (!isCallToolResult(raw)) throw this.invalidResponse(`工具 ${name} 返回格式不正确。`, { tool: name });
    return raw;
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    this.state = 'closing';
    this.pending.close(
      new EngineError('MCP_TRANSPORT_FAILED', { name: this.name, detail: '客户端已关闭' }),
    );
    try {
      await this.transport.close();
    } catch (error) {
      throw this.wrapError('MCP_TRANSPORT_FAILED', error, { detail: this.errorDetail(error) });
    } finally {
      this.state = 'closed';
      this.toolsCache = undefined;
    }
  }

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number,
    responseErrorCode: ErrorCode,
    context: Record<string, unknown> = {},
  ): Promise<unknown> {
    const pending = this.pending.request(
      method,
      params,
      timeoutMs,
      () => new EngineError('MCP_TIMEOUT', { name: this.name, method, timeoutMs, ...context }),
    );
    try {
      this.transport.send(pending.request);
    } catch (error) {
      const wrapped = this.wrapError('MCP_TRANSPORT_FAILED', error, { method, detail: this.errorDetail(error), ...context });
      this.pending.reject(pending.request.id, wrapped);
    }
    try {
      return await pending.response;
    } catch (error) {
      if (isEngineError(error)) throw error;
      if (error instanceof JsonRpcResponseError) {
        throw this.wrapError(responseErrorCode, error, {
          method,
          detail: error.rpcError.message,
          rpcCode: error.rpcError.code,
          ...context,
        });
      }
      throw this.wrapError(responseErrorCode, error, { method, detail: this.errorDetail(error), ...context });
    }
  }

  private handleTransportError(error: Error): void {
    if (this.state === 'closing' || this.state === 'closed') return;
    const code: ErrorCode =
      error instanceof McpInvalidResponseError
        ? 'MCP_INVALID_RESPONSE'
        : this.state === 'starting'
          ? 'MCP_SERVER_START_FAILED'
          : this.state === 'initializing'
            ? 'MCP_INIT_FAILED'
            : 'MCP_TRANSPORT_FAILED';
    this.pending.close(this.wrapError(code, error, { detail: error.message }));
    this.state = 'closed';
    void this.transport.close().catch(() => {});
  }

  private parseInitializeResult(value: unknown): InitializeResult {
    if (
      !isRecord(value) ||
      typeof value.protocolVersion !== 'string' ||
      !isRecord(value.capabilities) ||
      !isImplementationInfo(value.serverInfo) ||
      (value.instructions !== undefined && typeof value.instructions !== 'string')
    ) {
      throw this.invalidResponse('initialize 返回格式不正确。');
    }
    return {
      protocolVersion: value.protocolVersion,
      capabilities: value.capabilities,
      serverInfo: value.serverInfo,
      ...(typeof value.instructions === 'string' ? { instructions: value.instructions } : {}),
    };
  }

  private invalidResponse(detail: string, context: Record<string, unknown> = {}): EngineError {
    return new EngineError('MCP_INVALID_RESPONSE', { name: this.name, detail, ...context }, { technical: detail });
  }

  private wrapError(code: ErrorCode, error: unknown, context: Record<string, unknown>): EngineError {
    if (isEngineError(error)) return error;
    const detail = this.errorDetail(error);
    return new EngineError(code, { name: this.name, ...context }, { technical: detail, cause: error });
  }

  private errorDetail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private ensureRunning(): void {
    if (this.state !== 'running') {
      throw new EngineError('MCP_TRANSPORT_FAILED', { name: this.name, detail: '客户端尚未完成初始化' });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImplementationInfo(value: unknown): value is ImplementationInfo {
  return isRecord(value) && typeof value.name === 'string' && typeof value.version === 'string';
}

function isMcpTool(value: unknown): value is McpTool {
  if (!isRecord(value) || typeof value.name !== 'string' || !isRecord(value.inputSchema)) return false;
  if (value.inputSchema.type !== 'object') return false;
  if (value.description !== undefined && typeof value.description !== 'string') return false;
  if (value.inputSchema.properties !== undefined && !isRecord(value.inputSchema.properties)) return false;
  if (
    value.inputSchema.required !== undefined &&
    (!Array.isArray(value.inputSchema.required) || !value.inputSchema.required.every((item) => typeof item === 'string'))
  ) {
    return false;
  }
  return true;
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    isRecord(value) &&
    Array.isArray(value.content) &&
    value.content.every(isMcpContent) &&
    (value.isError === undefined || typeof value.isError === 'boolean')
  );
}

function isMcpContent(value: unknown): value is McpContent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'text') return typeof value.text === 'string';
  if (value.type === 'image') return typeof value.data === 'string' && typeof value.mimeType === 'string';
  if (value.type !== 'resource' || !isRecord(value.resource) || typeof value.resource.uri !== 'string') return false;
  return (
    (value.resource.mimeType === undefined || typeof value.resource.mimeType === 'string') &&
    (value.resource.text === undefined || typeof value.resource.text === 'string') &&
    (value.resource.blob === undefined || typeof value.resource.blob === 'string')
  );
}
