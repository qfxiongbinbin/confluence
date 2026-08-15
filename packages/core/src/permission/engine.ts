/**
 * F4.2 — the permission engine.
 *
 * Design rule from the PRD (§8.3-A): this is the gatekeeper. The agent loop
 * produces *intent*; nothing executes until this says yes. In the eventual
 * desktop app this code lives on the Rust side; keeping it a pure, dependency
 * free module means the port is mechanical.
 */

import { EngineError } from '../errors.js';
import type { PermissionRequest } from '../events.js';
import type { RiskLevel } from '../types.js';
import { checkDeny, forcedDenyRead, forcedDenyWrite, isInside, resolveRealPath, toAbsolute, type DenyRule } from './deny.js';

export type PermissionMode =
  /** Read-only. Any write or exec is refused outright. */
  | 'readonly'
  /** Every high-risk op asks. The default. */
  | 'step_confirm'
  /** File ops auto-approve; shell still asks. */
  | 'auto_edit'
  /** Allowlisted commands auto-approve; everything else asks. */
  | 'smart'
  /** Everything auto-approves. Sandbox still applies. */
  | 'full_auto';

export type NetworkPolicy = 'none' | 'allowlist' | 'all';

export interface PermissionProfile {
  mode: PermissionMode;
  /** Absolute paths the agent may touch. Defaults to [workingDir]. */
  allowedPaths: string[];
  /** User-added denies, on top of the non-removable forced list. */
  deniedPaths: string[];
  network: NetworkPolicy;
  allowedDomains: string[];
  commandAllowlist: string[];
  commandDenylist: string[];
  enabledTools: string[] | 'all';
  sandboxLevel: 'none' | 'os';
}

export const DEFAULT_COMMAND_DENYLIST = [
  // Destructive at scale. Not a security boundary (the sandbox is) but it
  // catches the overwhelmingly common accidents.
  String.raw`\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/`,
  String.raw`\bmkfs(\.\w+)?\b`,
  String.raw`\bdd\s+.*\bof=/dev/`,
  String.raw`>\s*/dev/(sd|nvme|disk)`,
  String.raw`\bshutdown\b|\breboot\b|\bhalt\b`,
  String.raw`\bchmod\s+-R\s+777\s+/`,
  String.raw`:\(\)\s*\{.*\|.*&\s*\}\s*;`, // fork bomb
  // Credential exfiltration shapes.
  String.raw`\bcurl\b[^|]*\|\s*(ba)?sh`,
  String.raw`\bwget\b[^|]*\|\s*(ba)?sh`,
];

export const DEFAULT_COMMAND_ALLOWLIST = [
  String.raw`^(ls|pwd|cat|head|tail|wc|file|stat|du|df)\b`,
  String.raw`^(git)\s+(status|log|diff|show|branch|remote|rev-parse)\b`,
  String.raw`^(rg|grep|find|fd)\b`,
  String.raw`^(node|python3?|tsc)\s+--version\b`,
  String.raw`^(echo|printf)\b`,
];

export function defaultProfile(workingDir: string): PermissionProfile {
  return {
    mode: 'step_confirm',
    allowedPaths: [workingDir],
    deniedPaths: [],
    network: 'none',
    allowedDomains: [],
    commandAllowlist: [...DEFAULT_COMMAND_ALLOWLIST],
    commandDenylist: [...DEFAULT_COMMAND_DENYLIST],
    enabledTools: 'all',
    sandboxLevel: 'os',
  };
}

export type Access = 'read' | 'write' | 'execute' | 'network';

export interface Decision {
  outcome: 'allow' | 'ask' | 'deny';
  /** Present when outcome is 'deny'. */
  error?: EngineError;
  /** Why, for the trace and the confirmation UI. */
  rationale: string;
}

export interface CheckInput {
  tool: string;
  risk: RiskLevel;
  access: Access;
  /** Filesystem paths this operation touches (relative paths resolved vs cwd). */
  paths?: string[];
  /** The shell command, when access is 'execute'. */
  command?: string;
  /** The target host, when access is 'network'. */
  host?: string;
}

export class PermissionEngine {
  private readonly denyWrite: DenyRule[];
  private readonly denyRead: DenyRule[];
  /** Grants the user made with "always allow in this task". */
  private readonly sessionGrants = new Set<string>();

  constructor(
    private profile: PermissionProfile,
    private readonly workingDir: string,
    appConfigDir: string,
  ) {
    // Real-path the app dir so the deny rule matches the symlink-resolved path
    // we check against below (e.g. /var -> /private/var on macOS).
    const appReal = resolveRealPath(appConfigDir);
    this.denyWrite = forcedDenyWrite(appReal);
    this.denyRead = forcedDenyRead(appReal);
  }

  getProfile(): PermissionProfile {
    return this.profile;
  }

  setMode(mode: PermissionMode): void {
    this.profile = { ...this.profile, mode };
  }

  grantForSession(key: string): void {
    this.sessionGrants.add(key);
  }

  /** Stable key for "always allow this in the current task". */
  static grantKey(input: CheckInput): string {
    if (input.access === 'execute') return `exec:${(input.command ?? '').split(/\s+/)[0] ?? ''}`;
    if (input.access === 'network') return `net:${input.host ?? ''}`;
    return `${input.access}:${input.tool}`;
  }

  /** Absolute, symlink-resolved form of a tool-reported path (relative → workingDir). */
  private realPath(p: string): string {
    return resolveRealPath(toAbsolute(this.workingDir, p));
  }

  check(input: CheckInput): Decision {
    // 1. Tool enablement.
    if (this.profile.enabledTools !== 'all' && !this.profile.enabledTools.includes(input.tool)) {
      return deny('PERMISSION_DENIED', { detail: `工具 ${input.tool} 未在本任务中启用`, mode: this.profile.mode });
    }

    // 2. Forced deny lists. These beat every mode, including full_auto.
    //    Paths are symlink-resolved so a link inside the working dir can't
    //    point at ~/.ssh or the app's own credentials and slip past by name.
    for (const p of input.paths ?? []) {
      const abs = this.realPath(p);
      const rules = input.access === 'read' ? this.denyRead : this.denyWrite;
      const hit = checkDeny(rules, abs);
      if (hit.denied) {
        return deny('PERMISSION_FORCED_DENY', { path: abs, detail: hit.reason });
      }
      // Writes also get checked against the read list's app-config entry, and
      // reads against nothing extra — but a write to a read-denied path is
      // equally bad, so check both directions for writes.
      if (input.access === 'write') {
        const alsoRead = checkDeny(this.denyRead, abs);
        if (alsoRead.denied) return deny('PERMISSION_FORCED_DENY', { path: abs, detail: alsoRead.reason });
      }
    }

    // 3. Path scope. Roots and the checked path are both resolved through
    //    symlinks so a link can't point outside the allowed roots.
    for (const p of input.paths ?? []) {
      const abs = this.realPath(p);
      if (!this.profile.allowedPaths.some((root) => isInside(resolveRealPath(root), abs))) {
        return deny('PERMISSION_PATH_OUT_OF_SCOPE', { path: abs });
      }
      if (this.profile.deniedPaths.some((root) => isInside(resolveRealPath(root), abs))) {
        return deny('PERMISSION_DENIED', { detail: `路径 ${abs} 在本任务的拒绝列表中`, mode: this.profile.mode });
      }
    }

    // 4. Network policy.
    let domainPreApproved = false;
    if (input.access === 'network') {
      if (this.profile.network === 'none') {
        return deny('PERMISSION_DENIED', {
          detail: `本任务禁止网络出站（目标 ${input.host}）。用 --network allowlist --allow-domain ${input.host} 放行`,
          mode: this.profile.mode,
        });
      }
      if (this.profile.network === 'allowlist') {
        if (!this.domainAllowed(input.host ?? '')) {
          return deny('PERMISSION_DENIED', {
            detail: `域名 ${input.host} 不在允许列表中`,
            mode: this.profile.mode,
          });
        }
        // Putting a domain on the allowlist IS the grant. Asking again for
        // every request to a domain the user explicitly named is pure friction.
        // `--network all` is different: a blanket opt-in is not a per-domain
        // decision, so those still go through the mode's normal flow.
        domainPreApproved = true;
      }
    }

    // 5. Command denylist — applies in every mode, including full_auto.
    if (input.access === 'execute' && input.command) {
      for (const pat of this.profile.commandDenylist) {
        if (new RegExp(pat, 'i').test(input.command)) {
          return deny('PERMISSION_DENIED', {
            detail: `命令匹配黑名单规则 /${pat}/`,
            mode: this.profile.mode,
          });
        }
      }
    }

    // 6. Read-only mode.
    if (this.profile.mode === 'readonly' && input.access !== 'read') {
      return deny('PERMISSION_DENIED', {
        detail: `当前为只读模式，不允许 ${describeAccess(input.access)}`,
        mode: this.profile.mode,
      });
    }

    // 7. Session grants.
    if (this.sessionGrants.has(PermissionEngine.grantKey(input))) {
      return { outcome: 'allow', rationale: '本任务内已授权' };
    }

    // 8. Mode-specific auto-approval.
    if (input.access === 'read' || input.risk === 'low') {
      return { outcome: 'allow', rationale: '低风险只读操作' };
    }
    if (domainPreApproved) {
      return { outcome: 'allow', rationale: `域名 ${input.host} 已在允许列表中` };
    }

    switch (this.profile.mode) {
      case 'full_auto':
        return { outcome: 'allow', rationale: '完全放行模式（沙箱仍生效）' };
      case 'auto_edit':
        if (input.access === 'write') return { outcome: 'allow', rationale: '自动编辑模式：文件写入自动通过' };
        return { outcome: 'ask', rationale: '自动编辑模式下 shell 命令仍需确认' };
      case 'smart':
        if (input.access === 'execute' && input.command && this.commandAllowlisted(input.command)) {
          return { outcome: 'allow', rationale: '命令在白名单中' };
        }
        if (input.access === 'write') return { outcome: 'allow', rationale: '智能审批模式：文件写入自动通过' };
        return { outcome: 'ask', rationale: '命令不在白名单中' };
      case 'step_confirm':
      default:
        return { outcome: 'ask', rationale: '逐步确认模式' };
    }
  }

  /** Build the confirmation payload shown to the user. */
  describe(input: CheckInput, id: string): PermissionRequest {
    const affects: string[] = [];
    for (const p of input.paths ?? []) affects.push(toAbsolute(this.workingDir, p));
    if (input.command) affects.push(`$ ${input.command}`);
    if (input.host) affects.push(`→ ${input.host}`);
    return {
      id,
      toolName: input.tool,
      args: {},
      risk: input.risk,
      summary: summarize(input),
      affects,
    };
  }

  private commandAllowlisted(cmd: string): boolean {
    return this.profile.commandAllowlist.some((p) => new RegExp(p, 'i').test(cmd.trim()));
  }

  private domainAllowed(host: string): boolean {
    const h = host.toLowerCase();
    return this.profile.allowedDomains.some((d) => {
      const dd = d.toLowerCase();
      return h === dd || h.endsWith(`.${dd}`);
    });
  }
}

function deny(code: 'PERMISSION_DENIED' | 'PERMISSION_FORCED_DENY' | 'PERMISSION_PATH_OUT_OF_SCOPE', ctx: Record<string, unknown>): Decision {
  const error = new EngineError(code, ctx);
  return { outcome: 'deny', error, rationale: error.userMessage };
}

function describeAccess(a: Access): string {
  return { read: '读取', write: '写入', execute: '执行命令', network: '网络访问' }[a];
}

function summarize(i: CheckInput): string {
  switch (i.access) {
    case 'execute':
      return `执行命令：${i.command}`;
    case 'network':
      return `访问网络：${i.host}`;
    case 'write':
      return `写入 ${i.paths?.length ?? 0} 个路径：${(i.paths ?? []).join('、')}`;
    default:
      return `${i.tool} 读取：${(i.paths ?? []).join('、')}`;
  }
}
