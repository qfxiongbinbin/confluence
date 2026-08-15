import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AgentRunner,
  PermissionEngine,
  ToolRegistry,
  defaultProfile,
  detectSandbox,
  isEngineError,
  loadMcpTools,
  type AgentRunOptions,
  type McpServerConfig,
  type Message,
  type PermissionAnswer,
  type PermissionMode,
  type PermissionProfile,
  type PermissionRequest,
} from '@confluence/core';
import type { AppConfig } from '../config.js';
import { c, confirm, duration, err, heading, info, kv, line, money, ok, warn, write } from '../ui.js';
import { flag } from './provider.js';

export async function runCommand(cfg: AppConfig, args: string[]): Promise<number> {
  const goal = args.find((a) => !a.startsWith('--') && !isFlagValue(args, a));
  if (!goal) {
    err('用法：cf run "<任务描述>" [选项]');
    line();
    heading('常用选项');
    kv('--dir <path>', '工作目录，默认当前目录', 24);
    kv('--mode <mode>', 'readonly | step_confirm | auto_edit | smart | full_auto', 24);
    kv('-m, --model <id>', '模型，格式 provider/model 或仅 model', 24);
    kv('--thinking <lvl>', 'off | low | medium | high | max', 24);
    kv('--network <p>', 'none | allowlist | all（默认 none）', 24);
    kv('--allow-domain <d>', '允许访问的域名，可重复', 24);
    kv('--allow-path <p>', '额外允许访问的路径，可重复', 24);
    kv('--budget <cny>', '本任务费用上限（人民币）', 24);
    kv('--max-steps <n>', '最大步数，默认 40', 24);
    kv('--sandbox <lvl>', 'os | none（默认 os；none 需显式承担风险）', 24);
    kv('--yes', '等价于 --mode full_auto（沙箱仍生效）', 24);
    return 1;
  }

  const settings = cfg.settings();
  const target = parseModel(flag(args, '-m') ?? flag(args, '--model'), settings);
  if (!target) {
    err('未指定模型，且没有默认模型。运行 cf provider add <id> 先配置一个。');
    return 1;
  }
  if (!cfg.getProviderRecord(target.providerId)) {
    err(`未配置服务商 ${target.providerId}。运行 cf provider add ${target.providerId}`);
    return 1;
  }

  const workingDir = resolve(flag(args, '--dir') ?? process.cwd());
  const profile = buildProfile(workingDir, args);

  // Fail-closed pre-flight: tell the user BEFORE the model burns tokens.
  if (profile.sandboxLevel === 'os') {
    const cap = detectSandbox();
    if (!cap.available) {
      err(`沙箱不可用：${cap.reason}`);
      if (cap.remedy) line(`  ${c.gray(cap.remedy)}`);
      line();
      line(`  引擎默认 fail-closed —— 不会在无沙箱的情况下执行 shell 工具。你可以：`);
      line(`    ${c.cyan('--mode readonly')}  只读运行（不需要沙箱）`);
      line(`    ${c.cyan('--sandbox none')}   显式承担风险，无 OS 级隔离`);
      return 1;
    }
  }

  const taskId = `task_${randomUUID().slice(0, 8)}`;
  const client = cfg.client({ modelId: target.modelId, onWarning: (m) => warn(m) });
  const tools = new ToolRegistry();
  const mcpConfigs = mergeMcpConfigs(cfg.listMcpServers(), loadProjectMcp(workingDir));
  const mcp = await loadMcpTools(mcpConfigs);
  for (const tool of mcp.tools) tools.register(tool);
  for (const failure of mcp.failures) warn(`MCP 服务器 ${failure.name} 启动失败：${failure.error.userMessage}`);
  const permissions = new PermissionEngine(profile, workingDir, cfg.dataRoot);
  const runner = new AgentRunner(client, tools, permissions, cfg.prices, makeResolver(profile.mode));

  cfg.store.createTask({
    id: taskId,
    title: goal.slice(0, 60),
    goal,
    mode: 'agent',
    workingDir,
    providerId: target.providerId,
    modelId: target.modelId,
    permission: profile,
  });

  heading(`任务 ${taskId}`);
  kv('目标', goal);
  kv('工作目录', workingDir);
  kv('模型', `${target.providerId}/${target.modelId}`);
  kv('权限模式', `${profile.mode}${profile.sandboxLevel === 'none' ? c.yellow('（无沙箱）') : ''}`);
  kv('网络', profile.network === 'none' ? '禁止出站' : `${profile.network} ${profile.allowedDomains.join(',')}`);
  if (mcp.tools.length > 0) kv('MCP', `${mcp.tools.length} 个工具（${mcp.clients.length} 个服务器）`);
  line();

  const controller = new AbortController();
  const onSigint = () => {
    line(`\n${c.yellow('正在中止…')}`);
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  const opts: AgentRunOptions = {
    taskId,
    goal,
    providerId: target.providerId,
    modelId: target.modelId,
    system: systemPrompt(workingDir, profile),
    workingDir,
    dataRoot: cfg.dataRoot,
    contextWindow: cfg.contextWindowFor(target.providerId, target.modelId),
    maxSteps: Number(flag(args, '--max-steps') ?? 40),
    signal: controller.signal,
    ...(flag(args, '--thinking') ? { thinking: flag(args, '--thinking') as AgentRunOptions['thinking'] } : {}),
    ...(flag(args, '--budget') ? { budgetCny: Number(flag(args, '--budget')) } : {}),
  };

  const messages: Message[] = [
    { id: `msg_${randomUUID().slice(0, 8)}`, role: 'user', content: [{ type: 'text', text: goal }], createdAt: Date.now() },
  ];

  const started = Date.now();
  let inReasoning = false;
  const gen = runner.run(messages, opts);
  let result;

  try {
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }
      const ev = next.value;
      switch (ev.type) {
        case 'step_start':
          line(c.gray(`\n── 第 ${ev.step} 步 ──`));
          break;
        case 'model_stream': {
          const se = ev.event;
          if (se.type === 'reasoning_delta') {
            if (!inReasoning) {
              write(c.gray('[思考] '));
              inReasoning = true;
            }
            write(c.gray(se.text));
          } else if (se.type === 'text_delta') {
            if (inReasoning) {
              write('\n');
              inReasoning = false;
            }
            write(se.text);
          } else if (se.type === 'done') {
            write('\n');
            inReasoning = false;
          }
          break;
        }
        case 'permission_request':
          break; // the resolver prints its own prompt
        case 'tool_start':
          line(`${c.blue('▸')} ${c.bold(ev.name)} ${c.gray(oneLine(ev.args))}`);
          break;
        case 'tool_output':
          write(c.gray(ev.chunk));
          break;
        case 'tool_end':
          line(`  ${ev.ok ? c.green('✓') : c.red('✗')} ${ev.summary} ${c.gray(`(${duration(ev.durationMs)})`)}`);
          break;
        case 'file_changed':
          if (ev.diff) line(c.gray(indent(ev.diff.split('\n').slice(0, 12).join('\n'), '    ')));
          break;
        case 'cost':
          line(c.gray(`  累计花费 ${money(ev.taskTotalCny)}`));
          break;
        case 'compaction':
          warn(`上下文已压缩（折叠 ${ev.removedMessages} 条消息）`);
          break;
        case 'notice':
          (ev.level === 'warn' ? warn : info)(ev.message);
          break;
        case 'task_end':
          break;
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
    await Promise.all(mcp.clients.map((mcpClient) => mcpClient.close().catch(() => {})));
  }

  // Persist everything so the task is resumable and auditable.
  cfg.store.saveMessages(taskId, result.messages);
  cfg.store.saveTrace(taskId, result.trace);
  cfg.store.updateTask(taskId, {
    status: result.error ? (result.stopReason === 'aborted' ? 'aborted' : 'failed') : 'completed',
    costCny: result.costCny,
    steps: result.steps,
    stopReason: result.stopReason,
  });
  recordUsage(cfg, taskId, target, result);

  line();
  heading('任务结束');
  kv('状态', result.error ? c.red(result.stopReason) : c.green(result.stopReason));
  kv('步数', String(result.steps));
  kv('耗时', duration(Date.now() - started));
  kv('token', `输入 ${result.usage.inputTokens} / 输出 ${result.usage.outputTokens} / 缓存命中 ${result.usage.cachedInputTokens}`);
  kv('花费', money(result.costCny));

  const changed = result.snapshots.list();
  if (changed.length) {
    kv('文件改动', `${changed.length} 个（cf task rollback ${taskId} 可回滚）`);
    const bad = result.snapshots.unrecoverable();
    if (bad.length) {
      warn(`其中 ${bad.length} 个文件不可回滚：`);
      for (const b of bad) line(`    ${b.originalPath} — ${b.skippedReason}`);
    }
    const commands = result.trace.filter((t) => t.type === 'tool_call' && t.payload['name'] === 'run_command').length;
    if (commands > 0) {
      warn(`注意：本任务执行了 ${commands} 条 shell 命令，命令的副作用（git 操作、包安装、网络请求等）不在回滚范围内。`);
    }
  }

  if (result.error) {
    line();
    err(result.error.userMessage);
    return 1;
  }
  info(`轨迹：cf task trace ${taskId}`);
  return 0;
}

// ---------------------------------------------------------------------------

export function buildProfile(workingDir: string, args: string[]): PermissionProfile {
  const p = defaultProfile(workingDir);
  const mode = args.includes('--yes') ? 'full_auto' : (flag(args, '--mode') as PermissionMode | undefined);
  if (mode) p.mode = mode;
  const network = flag(args, '--network');
  if (network === 'all' || network === 'allowlist' || network === 'none') p.network = network;
  for (const d of multiFlag(args, '--allow-domain')) {
    p.allowedDomains.push(d);
    if (p.network === 'none') p.network = 'allowlist';
  }
  for (const path of multiFlag(args, '--allow-path')) p.allowedPaths.push(resolve(path));
  if (flag(args, '--sandbox') === 'none') p.sandboxLevel = 'none';
  return p;
}

export function loadProjectMcp(workingDir: string): McpServerConfig[] {
  const path = join(workingDir, '.mcp.json');
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed['mcpServers'])) throw new Error('mcpServers 必须是对象');
    return Object.entries(parsed['mcpServers']).map(([name, config]) => {
      if (!isRecord(config)) throw new Error(`服务器 ${name} 的配置必须是对象`);
      return { ...config, name } as McpServerConfig;
    });
  } catch (error) {
    warn(`无法读取项目 MCP 配置 ${path}：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export function mergeMcpConfigs(global: McpServerConfig[], project: McpServerConfig[]): McpServerConfig[] {
  const merged = new Map(global.map((config) => [config.name, config]));
  for (const config of project) merged.set(config.name, config);
  return [...merged.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function makeResolver(mode: PermissionMode) {
  return async (req: PermissionRequest): Promise<PermissionAnswer> => {
    line();
    line(c.yellow(`需要确认（风险：${req.risk}）`));
    line(`  ${req.summary}`);
    for (const a of req.affects) line(`  ${c.gray(a)}`);
    if (mode === 'step_confirm') line(c.gray('  当前为逐步确认模式；用 --mode smart 可让白名单命令自动通过。'));
    const answer = await confirm('如何处理？', [
      { key: 'y', label: '允许这一次' },
      { key: 'a', label: '本任务内始终允许同类操作' },
      { key: 'n', label: '拒绝' },
      { key: 'r', label: '拒绝并说明原因（原因会反馈给模型）' },
    ]);
    if (answer === 'y') return { decision: 'allow' };
    if (answer === 'a') return { decision: 'allow_always' };
    if (answer === 'n') return { decision: 'deny' };
    const reason = await (await import('../ui.js')).prompt('原因：');
    return { decision: 'deny', reason };
  };
}

export function systemPrompt(workingDir: string, p: PermissionProfile): string {
  return [
    '你是一个运行在用户本地电脑上的 Agent。用户把一个工作目录交给你，你需要用工具真正完成任务，而不是只描述该怎么做。',
    '',
    `工作目录：${workingDir}`,
    `权限模式：${p.mode}`,
    `网络：${p.network === 'none' ? '禁止出站' : p.network === 'all' ? '允许' : `仅允许 ${p.allowedDomains.join(', ')}`}`,
    `沙箱：${p.sandboxLevel === 'os' ? '已启用 OS 级隔离' : '未启用（用户已显式承担风险）'}`,
    '',
    '规则：',
    '- 修改文件前先读取确认内容，不要凭猜测编辑。',
    '- 本引擎不提供删除文件的工具；确需删除时用 trash_file 移入回收站。',
    '- 高风险操作会弹给用户确认；被拒绝时不要绕道重试，改为询问用户意图。',
    '- 完成后用一段话说明你做了什么、改了哪些文件，不要重复贴出全部内容。',
  ].join('\n');
}

export function recordUsage(
  cfg: AppConfig,
  taskId: string,
  target: { providerId: string; modelId: string },
  result: { usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number }; costCny: number; error?: unknown },
): void {
  const cost = cfg.prices.cost(target.providerId, target.modelId, result.usage);
  cfg.store.recordUsage({
    id: `use_${randomUUID().slice(0, 8)}`,
    taskId,
    timestamp: Date.now(),
    providerId: target.providerId,
    modelId: target.modelId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedTokens: result.usage.cachedInputTokens,
    reasoningTokens: result.usage.reasoningTokens,
    costOriginal: cost.amountOriginal,
    currency: cost.currency,
    fxRate: cost.fxRate,
    fxSource: cost.fxSource,
    fxFetchedAt: cost.fxFetchedAt,
    costCny: result.costCny,
    status: result.error ? 'error' : 'success',
  });
}

export function parseModel(
  spec: string | undefined,
  settings: { defaultProvider?: string; defaultModel?: string },
): { providerId: string; modelId: string } | undefined {
  if (!spec) {
    if (!settings.defaultProvider || !settings.defaultModel) return undefined;
    return { providerId: settings.defaultProvider, modelId: settings.defaultModel };
  }
  const i = spec.indexOf('/');
  if (i === -1) {
    if (!settings.defaultProvider) return undefined;
    return { providerId: settings.defaultProvider, modelId: spec };
  }
  return { providerId: spec.slice(0, i), modelId: spec.slice(i + 1) };
}

function multiFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === name && args[i + 1]) out.push(args[i + 1]!);
  });
  return out;
}

function isFlagValue(args: string[], value: string): boolean {
  const i = args.indexOf(value);
  return i > 0 && args[i - 1]!.startsWith('--');
}

function oneLine(o: Record<string, unknown>): string {
  const s = JSON.stringify(o);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function indent(s: string, pad: string): string {
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

export { ok };
