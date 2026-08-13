/**
 * F10.5 — unified error code system.
 *
 * Rule: no raw HTTP response ever reaches the user. Every failure maps to a
 * code with (a) a Chinese user-facing message that says what to DO next, and
 * (b) a technical detail string for the debug panel.
 */

export type ErrorSeverity =
  /** Transient. The engine retries silently. */
  | 'retryable'
  /** The user has to change something. Show the fix. */
  | 'actionable'
  /** Nothing to do but report it. */
  | 'fatal';

export type ErrorCode =
  // provider / auth
  | 'PROVIDER_AUTH_INVALID'
  | 'PROVIDER_AUTH_MISSING'
  | 'PROVIDER_INSUFFICIENT_BALANCE'
  | 'PROVIDER_MODEL_NOT_ACTIVATED'
  | 'PROVIDER_MODEL_NOT_FOUND'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_CONCURRENCY_LIMITED'
  | 'PROVIDER_SERVER_ERROR'
  | 'PROVIDER_BAD_REQUEST'
  | 'PROVIDER_REASONING_ECHO_REQUIRED'
  | 'PROVIDER_THINKING_REQUIRED'
  | 'PROVIDER_CONTEXT_EXCEEDED'
  | 'PROVIDER_CONTENT_FILTERED'
  // network
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_UNREACHABLE'
  | 'NETWORK_TLS'
  | 'NETWORK_PROXY'
  // permission / sandbox
  | 'PERMISSION_DENIED'
  | 'PERMISSION_PATH_OUT_OF_SCOPE'
  | 'PERMISSION_FORCED_DENY'
  | 'PERMISSION_USER_REJECTED'
  | 'SANDBOX_UNAVAILABLE'
  | 'SANDBOX_SETUP_FAILED'
  // tools
  | 'TOOL_NOT_FOUND'
  | 'TOOL_BAD_ARGS'
  | 'TOOL_TIMEOUT'
  | 'TOOL_EXEC_FAILED'
  // MCP
  | 'MCP_SERVER_START_FAILED'
  | 'MCP_INIT_FAILED'
  | 'MCP_TOOL_CALL_FAILED'
  | 'MCP_TIMEOUT'
  | 'MCP_INVALID_RESPONSE'
  | 'MCP_TRANSPORT_FAILED'
  // engine
  | 'ENGINE_ABORTED'
  | 'ENGINE_MAX_STEPS'
  | 'ENGINE_BUDGET_EXCEEDED'
  | 'CONFIG_INVALID'
  | 'STORE_MIGRATION_FAILED'
  | 'UNKNOWN';

interface CodeSpec {
  severity: ErrorSeverity;
  /** User-facing Chinese text. Must end with a concrete next step. */
  message: (ctx: Record<string, unknown>) => string;
}

const s = (v: unknown, fallback = ''): string => (v === undefined || v === null ? fallback : String(v));

const SPECS: Record<ErrorCode, CodeSpec> = {
  PROVIDER_AUTH_INVALID: {
    severity: 'actionable',
    message: (c) => `${s(c.provider, '该服务商')} 的 API Key 无效或已过期。请到控制台重新生成后，用 \`cf provider set-key ${s(c.provider)}\` 更新。`,
  },
  PROVIDER_AUTH_MISSING: {
    severity: 'actionable',
    message: (c) => `尚未为 ${s(c.provider, '该服务商')} 配置 API Key。运行 \`cf provider set-key ${s(c.provider)}\` 添加。`,
  },
  PROVIDER_INSUFFICIENT_BALANCE: {
    severity: 'actionable',
    message: (c) => `${s(c.provider, '该服务商')} 账户余额不足。请充值后重试，或用 \`cf chat -m <其他模型>\` 换一个模型。`,
  },
  PROVIDER_MODEL_NOT_ACTIVATED: {
    severity: 'actionable',
    message: (c) =>
      `模型 ${s(c.model)} 尚未在 ${s(c.provider)} 控制台开通。火山方舟等平台需要先在「开通管理」里显式激活模型才能调用，开通后即可重试。`,
  },
  PROVIDER_MODEL_NOT_FOUND: {
    severity: 'actionable',
    message: (c) => `${s(c.provider)} 上不存在模型 ${s(c.model)}。用 \`cf model ls ${s(c.provider)}\` 查看可用模型，或手动添加模型名。`,
  },
  PROVIDER_RATE_LIMITED: {
    severity: 'retryable',
    message: (c) =>
      `${s(c.provider)} 触发限流（RPM/TPM）。这是账号等级限制，通常一分钟内恢复；充值提升等级可放宽。已自动退避重试。`,
  },
  PROVIDER_CONCURRENCY_LIMITED: {
    severity: 'retryable',
    message: (c) => `${s(c.provider)} 并发数已满。该服务商按并发限流而非 RPM，已自动排队重试。`,
  },
  PROVIDER_SERVER_ERROR: {
    severity: 'retryable',
    message: (c) => `${s(c.provider)} 服务端错误（${s(c.status)}）。已自动重试；若持续失败可切换到备用模型。`,
  },
  PROVIDER_BAD_REQUEST: {
    severity: 'actionable',
    message: (c) => `${s(c.provider)} 拒绝了请求：${s(c.detail, '参数不合法')}。这通常是模型参数约束问题，运行 \`cf doctor\` 查看该模型的参数限制。`,
  },
  PROVIDER_REASONING_ECHO_REQUIRED: {
    severity: 'fatal',
    message: () =>
      `请求被拒绝：历史消息中缺少 reasoning_content。DeepSeek 在多轮 + 工具调用场景下要求原样回传思维链——这是引擎的 bug，请附带 \`cf task trace <id>\` 的输出反馈。`,
  },
  PROVIDER_THINKING_REQUIRED: {
    severity: 'actionable',
    message: (c) => `模型 ${s(c.model)} 必须显式开启思考模式。加上 \`--thinking high\` 重试。`,
  },
  PROVIDER_CONTEXT_EXCEEDED: {
    severity: 'actionable',
    message: (c) => `上下文超出模型 ${s(c.model)} 的窗口上限。运行 \`/compact\` 压缩上下文，或换一个长上下文模型。`,
  },
  PROVIDER_CONTENT_FILTERED: {
    severity: 'actionable',
    message: (c) => `${s(c.provider)} 的内容安全策略拦截了本次请求或响应。调整措辞后重试，或换用其他服务商。`,
  },
  NETWORK_TIMEOUT: {
    severity: 'retryable',
    message: (c) => `连接 ${s(c.host, '服务商')} 超时。检查网络；若在国内访问境外服务商，需要配置代理（\`cf config proxy\`）。`,
  },
  NETWORK_UNREACHABLE: {
    severity: 'actionable',
    message: (c) => `无法连接 ${s(c.host, '服务商')}。若访问的是境外服务商，请配置代理：\`cf config proxy http://127.0.0.1:7890\`。`,
  },
  NETWORK_TLS: {
    severity: 'actionable',
    message: (c) => `与 ${s(c.host)} 的 TLS 握手失败。可能是代理证书或系统时间问题。`,
  },
  NETWORK_PROXY: {
    severity: 'actionable',
    message: (c) => `代理连接失败（${s(c.detail)}）。检查 \`cf config proxy\` 的设置，或用 \`cf config proxy --clear\` 清除。`,
  },
  PERMISSION_DENIED: {
    severity: 'actionable',
    message: (c) => `操作被权限策略拒绝：${s(c.detail)}。当前权限模式为 ${s(c.mode)}，可用 \`cf task perm <id> --mode\` 调整。`,
  },
  PERMISSION_PATH_OUT_OF_SCOPE: {
    severity: 'actionable',
    message: (c) => `路径 ${s(c.path)} 不在本任务的允许范围内。默认只允许访问工作目录；用 \`--allow-path\` 显式扩大范围。`,
  },
  PERMISSION_FORCED_DENY: {
    severity: 'fatal',
    message: (c) =>
      `路径 ${s(c.path)} 在强制拒绝清单中，任何权限模式都无法访问。这是为了防止 Agent 写入 git hooks、shell 启动文件或应用自身凭据等可用于持久化逃逸的位置。`,
  },
  PERMISSION_USER_REJECTED: {
    severity: 'actionable',
    message: (c) => `你拒绝了这次操作${c.reason ? `：${s(c.reason)}` : ''}。`,
  },
  SANDBOX_UNAVAILABLE: {
    severity: 'actionable',
    message: (c) => `沙箱不可用：${s(c.detail)}。引擎按 fail-closed 拒绝执行。运行 \`cf doctor\` 查看修复方法，或用 \`--sandbox none\` 显式承担风险。`,
  },
  SANDBOX_SETUP_FAILED: {
    severity: 'fatal',
    message: (c) => `沙箱初始化失败：${s(c.detail)}。`,
  },
  TOOL_NOT_FOUND: {
    severity: 'fatal',
    message: (c) => `模型请求了不存在的工具 ${s(c.tool)}。`,
  },
  TOOL_BAD_ARGS: {
    severity: 'retryable',
    message: (c) => `工具 ${s(c.tool)} 的参数不合法：${s(c.detail)}。已把错误反馈给模型重试。`,
  },
  TOOL_TIMEOUT: {
    severity: 'actionable',
    message: (c) => `工具 ${s(c.tool)} 执行超时（${s(c.timeoutMs)}ms）。用 \`--tool-timeout\` 调大超时，或缩小任务范围。`,
  },
  TOOL_EXEC_FAILED: {
    severity: 'retryable',
    message: (c) => `工具 ${s(c.tool)} 执行失败：${s(c.detail)}。`,
  },
  MCP_SERVER_START_FAILED: {
    severity: 'actionable',
    message: (c) => `无法启动 MCP 服务器 ${s(c.name, '')}：${s(c.detail, '未知错误')}。请检查命令路径与参数，或运行 \`cf doctor\` 排查。`,
  },
  MCP_INIT_FAILED: {
    severity: 'actionable',
    message: (c) => `MCP 服务器 ${s(c.name, '')} 初始化失败：${s(c.detail, '握手未完成')}。请检查服务器日志与 MCP 配置后重试。`,
  },
  MCP_TOOL_CALL_FAILED: {
    severity: 'retryable',
    message: (c) => `MCP 工具 ${s(c.tool, s(c.method))} 调用失败：${s(c.detail, '服务器返回错误')}。请检查工具参数与服务器日志后重试。`,
  },
  MCP_TIMEOUT: {
    severity: 'actionable',
    message: (c) => `MCP 服务器 ${s(c.name, '')} 的 ${s(c.method, '请求')} 超时（${s(c.timeoutMs)}ms）。请缩小任务范围或调大 MCP 超时时间后重试。`,
  },
  MCP_INVALID_RESPONSE: {
    severity: 'fatal',
    message: (c) => `MCP 服务器 ${s(c.name, '')} 返回了无效响应：${s(c.detail, '格式不符合协议')}。请升级或修复该 MCP 服务器后重试。`,
  },
  MCP_TRANSPORT_FAILED: {
    severity: 'actionable',
    message: (c) => `与 MCP 服务器 ${s(c.name, '')} 的连接失败：${s(c.detail, '传输已中断')}。请检查服务器状态、网络或进程日志后重试。`,
  },
  ENGINE_ABORTED: { severity: 'fatal', message: () => `任务已中止。轨迹已保存，可用 \`cf task resume <id>\` 从断点继续。` },
  ENGINE_MAX_STEPS: {
    severity: 'actionable',
    message: (c) => `达到最大步数上限（${s(c.max)}）。任务已暂停，用 \`cf task resume <id>\` 继续，或用 \`--max-steps\` 调大。`,
  },
  ENGINE_BUDGET_EXCEEDED: {
    severity: 'actionable',
    message: (c) => `本任务花费已达预算上限（¥${s(c.limit)}）。用 \`cf task resume <id> --budget <金额>\` 提高上限后继续。`,
  },
  CONFIG_INVALID: { severity: 'actionable', message: (c) => `配置有误：${s(c.detail)}。` },
  STORE_MIGRATION_FAILED: {
    severity: 'fatal',
    message: (c) => `数据库迁移失败：${s(c.detail)}。迁移前的备份保存在 ${s(c.backup)}，可用它恢复。`,
  },
  UNKNOWN: { severity: 'fatal', message: (c) => `未预期的错误：${s(c.detail)}。` },
};

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly severity: ErrorSeverity;
  /** Chinese, user-facing, ends with a next step. */
  readonly userMessage: string;
  readonly context: Record<string, unknown>;
  /** Raw upstream detail, for the debug panel only. */
  readonly technical?: string;
  readonly retryAfterMs?: number;

  constructor(
    code: ErrorCode,
    context: Record<string, unknown> = {},
    opts: { technical?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    const spec = SPECS[code] ?? SPECS.UNKNOWN;
    const userMessage = spec.message(context);
    super(`[${code}] ${userMessage}`);
    this.name = 'EngineError';
    this.code = code;
    this.severity = spec.severity;
    this.userMessage = userMessage;
    this.context = context;
    this.technical = opts.technical;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  get retryable(): boolean {
    return this.severity === 'retryable';
  }

  toJSON() {
    return {
      code: this.code,
      severity: this.severity,
      userMessage: this.userMessage,
      context: this.context,
      technical: this.technical,
    };
  }
}

export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError;
}

/** Wrap anything thrown into an EngineError so callers never see raw errors. */
export function toEngineError(e: unknown, fallbackCtx: Record<string, unknown> = {}): EngineError {
  if (isEngineError(e)) return e;
  if (e instanceof Error) {
    const code = classifyNodeError(e);
    const detail = describeChain(e);
    return new EngineError(
      code,
      // Without this, an unclassified error renders as "未预期的错误：。"
      { detail, ...fallbackCtx },
      { technical: detail, cause: e },
    );
  }
  return new EngineError('UNKNOWN', { ...fallbackCtx, detail: String(e) });
}

/**
 * Node's global fetch throws `TypeError: fetch failed` and hides the real
 * reason (ECONNREFUSED, ENOTFOUND, TLS failure) in `cause`. Walk the chain, or
 * every network problem looks identical to the user — which is exactly the
 * case that matters most here, since reaching overseas providers from China
 * usually needs a proxy.
 */
function walkCauses(e: Error): Error[] {
  const chain: Error[] = [e];
  let cur: unknown = e.cause;
  while (cur instanceof Error && chain.length < 6) {
    chain.push(cur);
    cur = cur.cause;
  }
  return chain;
}

function describeChain(e: Error): string {
  return walkCauses(e)
    .map((x) => {
      const code = (x as NodeJS.ErrnoException).code;
      return `${x.name}: ${x.message}${code ? ` (${code})` : ''}`;
    })
    .join(' ← ');
}

function classifyNodeError(e: Error): ErrorCode {
  for (const x of walkCauses(e)) {
    const code = (x as NodeJS.ErrnoException).code;
    const msg = x.message.toLowerCase();
    if (x.name === 'AbortError' || msg.includes('aborted')) return 'ENGINE_ABORTED';
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || msg.includes('timeout')) return 'NETWORK_TIMEOUT';
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') return 'NETWORK_UNREACHABLE';
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return 'NETWORK_UNREACHABLE';
    if (msg.includes('certificate') || msg.includes('tls') || msg.includes('ssl') || code === 'CERT_HAS_EXPIRED') {
      return 'NETWORK_TLS';
    }
    if (msg.includes('proxy')) return 'NETWORK_PROXY';
  }
  return 'UNKNOWN';
}
