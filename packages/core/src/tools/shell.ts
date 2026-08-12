import { spawn } from 'node:child_process';
import { EngineError } from '../errors.js';
import { wrapCommand } from '../sandbox/index.js';
import { num, str, type Tool, type ToolContext, type ToolResult } from './types.js';

/**
 * run_command.
 *
 * Two properties that matter more than the feature itself:
 *   - The child is put in its own process group, so "stop" actually kills the
 *     whole tree rather than orphaning it. Target is <1s from stop to dead.
 *   - When sandboxLevel is 'os' and no backend is available, this throws
 *     rather than running unsandboxed. Fail-closed, deliberately.
 */
export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    '执行 shell 命令。输出实时回显，支持超时与中止。注意：命令的副作用（git push、npm install、数据库写入等）不在快照回滚范围内。',
  risk: 'critical',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '工作目录，默认为任务工作目录' },
      timeout_ms: { type: 'number', description: '超时毫秒数，默认 120000' },
    },
    required: ['command'],
  },
  footprint(args, ctx) {
    return {
      access: 'execute',
      command: str(args, 'command'),
      paths: [args['cwd'] ? String(args['cwd']) : ctx.workingDir],
    };
  },
  async execute(args, ctx): Promise<ToolResult> {
    const command = str(args, 'command');
    const cwd = args['cwd'] ? String(args['cwd']) : ctx.workingDir;
    const timeoutMs = Math.max(1000, num(args, 'timeout_ms', ctx.timeoutMs));

    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

    // Throws SANDBOX_UNAVAILABLE if level is 'os' and no backend works.
    const wrapped = wrapCommand(
      shell,
      shellArgs,
      {
        readPaths: ctx.allowedPaths,
        writePaths: ctx.allowedPaths,
        network: ctx.networkAllowed,
        cwd,
      },
      ctx.sandboxLevel,
    );

    try {
      return await runOnce(wrapped.file, wrapped.args, cwd, timeoutMs, ctx, command, wrapped.backend);
    } finally {
      wrapped.cleanup();
    }
  },
};

function runOnce(
  file: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  ctx: ToolContext,
  displayCommand: string,
  backend: string,
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(file, argv, {
      cwd,
      // Own process group so we can kill the entire tree, not just the shell.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CF_SANDBOXED: backend },
    });

    let stdout = '';
    let stderr = '';
    let killedBy: 'timeout' | 'abort' | undefined;
    const MAX_CAPTURE = 200_000;

    const capture = (stream: 'stdout' | 'stderr') => (buf: Buffer) => {
      const text = buf.toString('utf8');
      ctx.onOutput?.(stream, text);
      if (stream === 'stdout') {
        if (stdout.length < MAX_CAPTURE) stdout += text;
      } else if (stderr.length < MAX_CAPTURE) stderr += text;
    };
    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        } else if (child.pid) {
          process.kill(-child.pid, signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      killedBy = 'timeout';
      killTree('SIGTERM');
      // Escalate if it ignores SIGTERM — the <1s stop requirement.
      setTimeout(() => killTree('SIGKILL'), 800);
    }, timeoutMs);

    const onAbort = () => {
      killedBy = 'abort';
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 800);
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        ok: false,
        content: `命令启动失败：${err.message}`,
        summary: `启动失败：${displayCommand.slice(0, 60)}`,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);

      if (killedBy === 'timeout') {
        resolvePromise({
          ok: false,
          content: `命令超时（${timeoutMs}ms）已终止。\n已捕获输出：\n${tail(stdout)}\n${tail(stderr)}`,
          summary: `超时终止：${displayCommand.slice(0, 60)}`,
          meta: { timedOut: true, timeoutMs },
        });
        return;
      }
      if (killedBy === 'abort') {
        resolvePromise({
          ok: false,
          content: '命令已被用户中止。',
          summary: `已中止：${displayCommand.slice(0, 60)}`,
          meta: { aborted: true },
        });
        return;
      }

      const ok = code === 0;
      const parts = [`退出码：${code ?? `信号 ${signal}`}`];
      if (stdout.trim()) parts.push(`stdout:\n${tail(stdout)}`);
      if (stderr.trim()) parts.push(`stderr:\n${tail(stderr)}`);
      resolvePromise({
        ok,
        content: parts.join('\n'),
        summary: `${ok ? '成功' : '失败'}（退出码 ${code}）：${displayCommand.slice(0, 60)}`,
        meta: { exitCode: code, signal, sandbox: backend },
      });
    });
  });
}

function tail(s: string, max = 20_000): string {
  if (s.length <= max) return s;
  return `…（已省略前 ${s.length - max} 字节）\n${s.slice(-max)}`;
}

export function assertSandboxOrThrow(level: 'none' | 'os'): void {
  if (level === 'none') return;
  // Surfaces the same error the tool would raise, for pre-flight checks.
  wrapCommand('/bin/true', [], { readPaths: [], writePaths: [], network: false, cwd: process.cwd() }, level);
}

export { EngineError };
