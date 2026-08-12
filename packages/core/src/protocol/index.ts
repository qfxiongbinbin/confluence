import type { StreamEvent } from '../events.js';
import type { ProviderQuirks } from '../providers/quirks.js';
import type { ModelRequest } from '../types.js';

export interface WireContext {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  authHeader: 'bearer' | 'x-api-key';
  quirks: ProviderQuirks;
  extraHeaders?: Record<string, string>;
  /** Node fetch dispatcher for proxying, injected by the client. */
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export interface BuiltRequest {
  url: string;
  init: RequestInit;
  /** Warnings produced while normalizing params (shown to the user once). */
  warnings: string[];
}

export interface ProtocolAdapter {
  readonly name: string;
  build(ctx: WireContext, req: ModelRequest): BuiltRequest;
  /** Parse a streaming response body into unified events. */
  parseStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
  /** Parse a non-streaming response. */
  parseOnce(json: unknown): StreamEvent[];
  /** Map an error response body + status to an EngineError context. */
  classifyError(status: number, body: string): { code: import('../errors.js').ErrorCode; detail: string };
}
