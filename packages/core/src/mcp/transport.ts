import type { JsonRpcMessage } from './types.js';

export interface McpTransport {
  start(): Promise<void>;
  send(msg: JsonRpcMessage): void;
  close(): Promise<void>;
  onMessage: (msg: JsonRpcMessage) => void;
  onError: (err: Error) => void;
}

export class McpInvalidResponseError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'McpInvalidResponseError';
  }
}
