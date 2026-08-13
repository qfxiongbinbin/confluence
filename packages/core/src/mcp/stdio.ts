import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { isJsonRpcMessage } from './jsonrpc.js';
import { McpInvalidResponseError, type McpTransport } from './transport.js';
import type { JsonRpcMessage } from './types.js';

const STDERR_LIMIT = 8 * 1024;

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export class StdioTransport implements McpTransport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  onError: (err: Error) => void = () => {};

  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closing = false;
  private exited = false;

  constructor(private readonly options: StdioTransportOptions) {}

  async start(): Promise<void> {
    if (this.child && !this.exited) return;
    this.closing = false;
    this.exited = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';

    const child = spawn(this.options.command, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.options.env },
      cwd: this.options.cwd,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk));
    child.stderr.on('data', (chunk: string) => this.consumeStderr(chunk));
    child.on('exit', (code, signal) => {
      this.exited = true;
      if (!this.closing) {
        this.onError(new Error(this.exitMessage(code, signal)));
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onInitialError);
        child.on('error', (error) => {
          if (!this.closing) this.onError(error);
        });
        resolve();
      };
      const onInitialError = (error: Error) => {
        this.exited = true;
        child.off('spawn', onSpawn);
        this.onError(error);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onInitialError);
    });
  }

  send(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child || this.exited || child.exitCode !== null || child.killed || !child.stdin.writable) {
      throw new Error(`MCP stdio 进程不可用。${this.stderrSuffix()}`);
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    if (!this.exited && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.stdin.end();
    this.child = undefined;
    this.stdoutBuffer = '';
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.parseLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private parseLine(line: string): void {
    try {
      const value: unknown = JSON.parse(line);
      if (!isJsonRpcMessage(value)) throw new McpInvalidResponseError('MCP stdio 返回了无效的 JSON-RPC 消息。');
      this.onMessage(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onError(
        error instanceof McpInvalidResponseError
          ? error
          : new McpInvalidResponseError(`无法解析 MCP stdio 响应：${detail}`, { cause: error }),
      );
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-STDERR_LIMIT);
  }

  private exitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const status = signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`;
    return `MCP stdio 进程已退出（${status}）。${this.stderrSuffix()}`;
  }

  private stderrSuffix(): string {
    const stderr = this.stderrBuffer.trim();
    return stderr ? `stderr：${stderr}` : 'stderr 无输出。';
  }
}
