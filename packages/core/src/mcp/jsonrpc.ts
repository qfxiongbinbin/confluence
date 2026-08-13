import type {
  JsonRpcError,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types.js';

export const JSON_RPC_ERROR_CODES = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasValidId(value: Record<string, unknown>): boolean {
  return typeof value.id === 'number' || typeof value.id === 'string';
}

export function isRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && value.jsonrpc === '2.0' && hasValidId(value) && typeof value.method === 'string';
}

export function isNotification(value: unknown): value is JsonRpcNotification {
  return isRecord(value) && value.jsonrpc === '2.0' && !('id' in value) && typeof value.method === 'string';
}

export function isResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || !hasValidId(value) || 'method' in value) return false;
  if (!('result' in value) && !('error' in value)) return false;
  if (!('error' in value) || value.error === undefined) return true;
  return isJsonRpcError(value.error);
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isRequest(value) || isNotification(value) || isResponse(value);
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  return isRecord(value) && typeof value.code === 'number' && typeof value.message === 'string';
}

export function createRequest(id: number | string, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
}

export function createNotification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
}

export class JsonRpcResponseError extends Error {
  readonly rpcError: JsonRpcError;

  constructor(error: JsonRpcError) {
    super(`JSON-RPC ${error.code}: ${error.message}`);
    this.name = 'JsonRpcResponseError';
    this.rpcError = error;
  }
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingMapOptions {
  onRequest?: (request: JsonRpcRequest) => void;
  onNotification?: (notification: JsonRpcNotification) => void;
}

export interface PendingRequest {
  request: JsonRpcRequest;
  response: Promise<unknown>;
}

export class PendingMap {
  private nextRequestId = 1;
  private readonly pending = new Map<number | string, PendingEntry>();
  private readonly onRequest?: (request: JsonRpcRequest) => void;
  private readonly onNotification?: (notification: JsonRpcNotification) => void;
  private closedError?: Error;

  constructor(options: PendingMapOptions = {}) {
    this.onRequest = options.onRequest;
    this.onNotification = options.onNotification;
  }

  request(method: string, params: unknown, timeoutMs: number, timeoutError: () => Error): PendingRequest {
    const id = this.nextRequestId++;
    const request = createRequest(id, method, params);
    const response = new Promise<unknown>((resolve, reject) => {
      if (this.closedError) {
        reject(this.closedError);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError());
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    return { request, response };
  }

  handleMessage(message: JsonRpcMessage): boolean {
    if (isResponse(message)) {
      const entry = this.pending.get(message.id);
      if (!entry) return false;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new JsonRpcResponseError(message.error));
      else entry.resolve(message.result);
      return true;
    }
    if (isRequest(message)) {
      this.onRequest?.(message);
      return false;
    }
    this.onNotification?.(message);
    return false;
  }

  reject(id: number | string, error: Error): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
    return true;
  }

  close(error: Error): void {
    this.closedError = error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
