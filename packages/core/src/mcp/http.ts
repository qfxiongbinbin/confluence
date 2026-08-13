import { isJsonRpcMessage } from './jsonrpc.js';
import { readSse } from '../protocol/sse.js';
import { McpInvalidResponseError, type McpTransport } from './transport.js';
import type { JsonRpcMessage } from './types.js';

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HttpTransport implements McpTransport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onError: (err: Error) => void = () => {};

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly controllers = new Set<AbortController>();
  private sessionId?: string;
  private closed = false;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async start(): Promise<void> {
    this.closed = false;
  }

  send(message: JsonRpcMessage): void {
    if (this.closed) throw new Error('MCP HTTP transport 已关闭。');
    void this.post(message).catch((error: unknown) => {
      if (this.closed && error instanceof Error && error.name === 'AbortError') return;
      this.onError(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.sessionId = undefined;
  }

  private async post(message: JsonRpcMessage): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        ...this.options.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      const response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const sessionId = response.headers.get('Mcp-Session-Id');
      if (sessionId) this.sessionId = sessionId;
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`MCP HTTP 请求失败（${response.status} ${response.statusText}）${detail ? `：${detail}` : ''}`);
      }
      if (response.status === 202 || response.status === 204) return;

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType.includes('text/event-stream')) {
        if (!response.body) throw new McpInvalidResponseError('MCP SSE 响应缺少消息体。');
        for await (const event of readSse(response.body, controller.signal)) {
          if (event.data.trim()) this.deliverJson(event.data);
        }
        return;
      }

      const text = await response.text();
      if (!text.trim()) return;
      if (!contentType.includes('application/json')) {
        throw new McpInvalidResponseError(`MCP HTTP 返回了不支持的 Content-Type：${contentType || '未提供'}`);
      }
      const parsed: unknown = this.parseJson(text);
      const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of messages) this.deliver(item);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private deliverJson(text: string): void {
    this.deliver(this.parseJson(text));
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new McpInvalidResponseError('无法解析 MCP HTTP 返回的 JSON。', { cause: error });
    }
  }

  private deliver(value: unknown): void {
    if (!isJsonRpcMessage(value)) throw new McpInvalidResponseError('MCP HTTP 返回了无效的 JSON-RPC 消息。');
    this.onMessage(value);
  }
}
