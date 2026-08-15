/**
 * F4.3 — OS-level sandbox.
 *
 * MVP scope, honestly stated:
 *   macOS   — Seatbelt via sandbox-exec. Kernel-enforced.
 *   Linux   — bubblewrap + seccomp-ish namespace isolation. FAIL-CLOSED:
 *             if bwrap is missing or blocked we refuse to run, we do NOT
 *             silently degrade (Claude Code's fail-open behaviour is the thing
 *             we explicitly decided not to copy).
 *   Windows — not implemented in the MVP. Reported as unavailable so the UI
 *             can say so plainly instead of implying protection that isn't there.
 *
 * Everything goes through this one module so it can be swapped for
 * @anthropic-ai/sandbox-runtime (or a Rust implementation) without touching
 * call sites — that package is still 0.0.x and its config format may change.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EngineError } from '../errors.js';

export type SandboxBackend = 'seatbelt' | 'bubblewrap' | 'none';

export interface SandboxCapability {
  backend: SandboxBackend;
  available: boolean;
  /** Why it isn't available, and how to fix it. */
  reason?: string;
  remedy?: string;
  platform: NodeJS.Platform;
}

export interface SandboxSpec {
  /** Paths the process may read. */
  readPaths: string[];
  /** Paths the process may write. */
  writePaths: string[];
  /** false => no outbound network at all. */
  network: boolean;
  cwd: string;
}

export interface WrappedCommand {
  file: string;
  args: string[];
  /** Temp files to clean up after the run. */
  cleanup: () => void;
  backend: SandboxBackend;
}

let cached: SandboxCapability | undefined;

export function detectSandbox(force = false): SandboxCapability {
  if (cached && !force) return cached;
  const platform = process.platform;

  if (platform === 'darwin') {
    const bin = '/usr/bin/sandbox-exec';
    if (!existsSync(bin)) {
      cached = {
        backend: 'seatbelt',
        available: false,
        platform,
        reason: '/usr/bin/sandbox-exec 不存在',
        remedy: '这是 macOS 系统自带组件，缺失通常意味着系统被裁剪过。',
      };
      return cached;
    }
    // Binary presence isn't enough: when this process already runs inside a
    // Seatbelt sandbox, the kernel refuses a nested sandbox_apply at runtime.
    // Probe like the Linux branch does instead of assuming.
    if (!seatbeltProbeAvailable(bin)) {
      cached = {
        backend: 'seatbelt',
        available: false,
        platform,
        reason: 'sandbox-exec 自检失败：当前环境不允许再套一层 Seatbelt 沙箱（常见于已在沙箱内运行）',
        remedy: '在非沙箱环境中运行，或显式 --sandbox none 承担风险。',
      };
      return cached;
    }
    cached = { backend: 'seatbelt', available: true, platform };
    return cached;
  }

  if (platform === 'linux') {
    const bwrap = which('bwrap');
    if (!bwrap) {
      cached = {
        backend: 'bubblewrap',
        available: false,
        platform,
        reason: '未找到 bubblewrap（bwrap）',
        remedy: '安装：sudo apt install bubblewrap（Ubuntu/Debian）或 sudo dnf install bubblewrap（Fedora）',
      };
      return cached;
    }
    // Ubuntu 23.10+ / 24.04 default-enable this AppArmor knob, which blocks
    // unprivileged user namespaces for binaries without a profile — bwrap then
    // fails at runtime even though it's installed. Probe rather than assume.
    const probe = spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    if (probe.status !== 0) {
      const restricted = readSysctl('kernel/apparmor_restrict_unprivileged_userns');
      cached = {
        backend: 'bubblewrap',
        available: false,
        platform,
        reason:
          restricted === '1'
            ? 'bubblewrap 已安装但被 AppArmor 的 apparmor_restrict_unprivileged_userns 阻断（Ubuntu 23.10+ / 24.04 默认开启）'
            : `bubblewrap 自检失败（退出码 ${probe.status}）`,
        remedy:
          restricted === '1'
            ? '两种解法：① 为本应用安装 AppArmor profile（正式版将随包投递）；② 临时放开：sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'
            : '运行 `bwrap --ro-bind / / --dev /dev true` 查看具体报错。',
      };
      return cached;
    }
    cached = { backend: 'bubblewrap', available: true, platform };
    return cached;
  }

  cached = {
    backend: 'none',
    available: false,
    platform,
    reason: 'Windows 的 OS 级沙箱尚未在 MVP 中实现',
    remedy:
      '当前仅有应用层权限确认保护，隔离强度较低。若需强隔离，请在 WSL2 中运行，或用 --permission-mode readonly 限制为只读。',
  };
  return cached;
}

/**
 * Wrap a command for sandboxed execution.
 *
 * Throws SANDBOX_UNAVAILABLE when the requested level is 'os' but no backend
 * works. Callers must not catch-and-continue: that is exactly the fail-open
 * behaviour we are avoiding.
 */
export function wrapCommand(
  file: string,
  args: string[],
  spec: SandboxSpec,
  level: 'none' | 'os',
): WrappedCommand {
  if (level === 'none') {
    return { file, args, cleanup: () => {}, backend: 'none' };
  }

  const cap = detectSandbox();
  if (!cap.available) {
    throw new EngineError('SANDBOX_UNAVAILABLE', {
      detail: `${cap.reason}。${cap.remedy ?? ''}`,
    });
  }

  if (cap.backend === 'seatbelt') return wrapSeatbelt(file, args, spec);
  if (cap.backend === 'bubblewrap') return wrapBubblewrap(file, args, spec);
  throw new EngineError('SANDBOX_UNAVAILABLE', { detail: cap.reason ?? '无可用沙箱后端' });
}

// ---------------------------------------------------------------------------
// macOS Seatbelt
// ---------------------------------------------------------------------------

/** Run a minimal profile through sandbox-exec to see whether it actually applies. */
function seatbeltProbeAvailable(bin: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'cf-sb-probe-'));
  try {
    const profile = join(dir, 'probe.sb');
    writeFileSync(
      profile,
      [
        '(version 1)',
        '(deny default)',
        '(import "/System/Library/Sandbox/Profiles/bsd.sb")',
        '(allow process-exec)',
        '(allow file-read*)',
      ].join('\n') + '\n',
      'utf8',
    );
    const probe = spawnSync(bin, ['-f', profile, '/usr/bin/true'], { stdio: 'ignore', timeout: 5000 });
    return probe.status === 0;
  } finally {
    try {
      execFileSync('rm', ['-rf', dir], { stdio: 'ignore' });
    } catch {
      /* best effort */
    }
  }
}

function wrapSeatbelt(file: string, args: string[], spec: SandboxSpec): WrappedCommand {
  const dir = mkdtempSync(join(tmpdir(), 'cf-sb-'));
  const profilePath = join(dir, 'policy.sb');
  writeFileSync(profilePath, seatbeltProfile(spec), 'utf8');
  return {
    file: '/usr/bin/sandbox-exec',
    args: ['-f', profilePath, file, ...args],
    cleanup: () => {
      try {
        execFileSync('rm', ['-rf', dir], { stdio: 'ignore' });
      } catch {
        /* best effort */
      }
    },
    backend: 'seatbelt',
  };
}

function seatbeltProfile(spec: SandboxSpec): string {
  const lit = (p: string) => `(subpath ${JSON.stringify(resolve(p))})`;
  const lines = [
    '(version 1)',
    '(deny default)',
    '(import "/System/Library/Sandbox/Profiles/bsd.sb")',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow signal (target self))',
    // Read: system paths plus whatever the task allows.
    `(allow file-read* ${['/usr', '/bin', '/sbin', '/System', '/Library', '/private/var/select', '/opt', '/etc', '/dev']
      .map(lit)
      .join(' ')})`,
  ];
  if (spec.readPaths.length) lines.push(`(allow file-read* ${spec.readPaths.map(lit).join(' ')})`);
  if (spec.writePaths.length) lines.push(`(allow file-write* ${spec.writePaths.map(lit).join(' ')})`);
  lines.push(`(allow file-write* ${lit(tmpdir())})`, `(allow file-read* ${lit(tmpdir())})`);
  lines.push('(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))');
  if (spec.network) lines.push('(allow network*)');
  else lines.push('(deny network*)');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Linux bubblewrap
// ---------------------------------------------------------------------------

function wrapBubblewrap(file: string, args: string[], spec: SandboxSpec): WrappedCommand {
  const bwrap = which('bwrap')!;
  const a: string[] = [
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ];
  if (!spec.network) a.push('--unshare-net');

  for (const p of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt']) {
    if (existsSync(p)) a.push('--ro-bind', p, p);
  }
  for (const p of spec.readPaths) {
    if (existsSync(p)) a.push('--ro-bind', resolve(p), resolve(p));
  }
  // Write binds come last so they override any read-only bind above.
  for (const p of spec.writePaths) {
    if (existsSync(p)) a.push('--bind', resolve(p), resolve(p));
  }
  a.push('--chdir', resolve(spec.cwd), '--', file, ...args);

  return { file: bwrap, args: a, cleanup: () => {}, backend: 'bubblewrap' };
}

// ---------------------------------------------------------------------------

function which(bin: string): string | undefined {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status !== 0) return undefined;
  const p = r.stdout.trim().split('\n')[0];
  return p && existsSync(p) ? p : undefined;
}

function readSysctl(path: string): string | undefined {
  try {
    const r = spawnSync('cat', [`/proc/sys/${path}`], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** For `cf doctor`. */
export function sandboxReport(): { capability: SandboxCapability; advice: string[] } {
  const cap = detectSandbox(true);
  const advice: string[] = [];
  if (cap.available) {
    advice.push(`沙箱可用：${cap.backend}（${cap.platform}）`);
    if (cap.backend === 'seatbelt') {
      advice.push('注意：sandbox-exec 已被 Apple 标记 deprecated 多年，仍是 Claude Code / Codex 的生产方案，但属于长期风险。');
    }
  } else {
    advice.push(`沙箱不可用：${cap.reason}`);
    if (cap.remedy) advice.push(`修复方法：${cap.remedy}`);
    advice.push('在沙箱不可用时，引擎默认 fail-closed 拒绝执行 shell 工具。用 --sandbox none 可显式承担风险。');
  }
  advice.push('边界声明：沙箱降低泄露影响但不消除风险。允许网络出站就可能泄露 Agent 能读到的数据；可写挂载项目目录就可能改代码。隔离不改变发送给模型的内容。');
  return { capability: cap, advice };
}
