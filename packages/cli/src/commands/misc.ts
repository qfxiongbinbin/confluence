import { randomUUID } from 'node:crypto';
import {
  KeychainSecretStore,
  SnapshotStore,
  detectSandbox,
  findPreset,
  isEngineError,
  sandboxReport,
  type Message,
  type Usage,
} from '@confluence/core';
import type { AppConfig } from '../config.js';
import { c, duration, err, heading, info, kv, line, money, ok, table, warn, write } from '../ui.js';
import { flag } from './provider.js';
import { parseModel } from './run.js';

// ---------------------------------------------------------------------------
// cf doctor
// ---------------------------------------------------------------------------

export function doctorCommand(cfg: AppConfig): number {
  heading('运行环境');
  kv('Node', process.version);
  kv('平台', `${process.platform} ${process.arch}`);
  kv('数据目录', cfg.dataRoot);

  heading('沙箱');
  const { capability, advice } = sandboxReport();
  kv('后端', capability.backend);
  kv('可用', capability.available ? c.green('是') : c.red('否'));
  line();
  for (const a of advice) line(`  ${c.gray(a)}`);

  heading('密钥存储');
  const backend = cfg.secrets().backend;
  kv('当前后端', backend);
  if (backend === 'env') {
    warn('当前只能从环境变量读取密钥，无法持久化保存。');
    line(`  ${c.gray('设置主密码：export CF_MASTER_PASSWORD=\'...\'（AES-256-GCM 加密到 vault.json）')}`);
    if (process.platform === 'linux' && !KeychainSecretStore.available()) {
      line(`  ${c.gray('或安装系统密钥链：sudo apt install libsecret-tools')}`);
    }
  } else {
    ok(`使用 ${backend === 'keychain' ? '系统密钥链' : '加密文件（AES-256-GCM + scrypt）'}`);
  }
  line();
  line(`  ${c.gray('边界声明：本地密钥存储不防护「同一用户身份下的恶意进程」与「运行时内存提取」。')}`);

  heading('服务商');
  const records = cfg.listProviders();
  if (records.length === 0) {
    warn('尚未配置服务商。运行 cf provider add deepseek 开始。');
  } else {
    const secrets = cfg.secrets();
    for (const r of records) {
      const key = secrets.get(r.id);
      const status = !r.enabled ? c.gray('已禁用') : key || r.local ? c.green('就绪') : c.yellow('缺少 Key');
      line(`  ${status}  ${r.id.padEnd(14)} ${c.gray(r.baseUrl)}`);
      const preset = r.presetId ? findPreset(r.presetId) : undefined;
      for (const n of preset?.quirks.notes ?? []) line(`         ${c.gray(`· ${n}`)}`);
    }
  }

  heading('汇率');
  const fx = cfg.prices.getFx();
  const age = fx.fetchedAt === 0 ? '从未更新（使用内置兜底值）' : `${Math.floor((Date.now() - fx.fetchedAt) / 86_400_000)} 天前`;
  kv('USD → CNY', `${fx.rate}（来源 ${fx.source}，${age}）`);
  if (fx.fetchedAt === 0) {
    line(`  ${c.gray('国外模型的人民币折算用的是内置兜底汇率，仅供参考。用 cf config fx <rate> 手动设置。')}`);
  }

  const unverified = cfg.prices.list().filter((p) => !p.verified);
  if (unverified.length) {
    heading('价格表中未经核实的条目');
    for (const p of unverified) line(`  ${c.yellow('?')} ${p.providerId}/${p.modelId} — ${p.note ?? '未核实'}`);
    line(`\n  ${c.gray('用 cf price set <provider> <model> --input X --output Y 覆盖。')}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// cf task
// ---------------------------------------------------------------------------

export function taskCommand(cfg: AppConfig, args: string[]): number {
  const sub = args[0] ?? 'ls';
  if (sub === 'ls') {
    const tasks = cfg.store.listTasks(Number(flag(args, '--limit') ?? 30));
    if (tasks.length === 0) {
      info('还没有任务。运行 cf run "<任务描述>" 创建一个。');
      return 0;
    }
    heading('任务');
    table(
      tasks.map((t) => [
        t.id,
        statusColor(t.status),
        t.title.slice(0, 40),
        `${t.provider_id}/${t.model_id}`,
        money(t.cost_cny),
        new Date(t.updated_at).toLocaleString('zh-CN'),
      ]),
      ['ID', '状态', '标题', '模型', '花费', '更新时间'],
    );
    return 0;
  }

  const id = args[1];
  if (!id) {
    err(`用法：cf task ${sub} <task-id>`);
    return 1;
  }
  const task = cfg.store.getTask(id);
  if (!task) {
    err(`找不到任务 ${id}`);
    return 1;
  }

  if (sub === 'show') {
    heading(`任务 ${task.id}`);
    kv('标题', task.title);
    kv('目标', task.goal);
    kv('状态', statusColor(task.status));
    kv('工作目录', task.working_dir ?? '—');
    kv('模型', `${task.provider_id}/${task.model_id}`);
    kv('步数', String(task.steps));
    kv('花费', money(task.cost_cny));
    kv('创建', new Date(task.created_at).toLocaleString('zh-CN'));
    const msgs = cfg.store.loadMessages(id);
    heading(`消息（${msgs.length} 条）`);
    for (const m of msgs.slice(-6)) line(`  ${c.gray(m.role.padEnd(10))}${summarizeMessage(m).slice(0, 100)}`);
    return 0;
  }

  if (sub === 'trace') {
    const trace = cfg.store.loadTrace(id);
    heading(`执行轨迹（${trace.length} 条）`);
    for (const e of trace) {
      const t = new Date(e.timestamp).toLocaleTimeString('zh-CN');
      const cost = e.costCny ? c.gray(` ${money(e.costCny)}`) : '';
      const dur = e.durationMs ? c.gray(` ${duration(e.durationMs)}`) : '';
      line(`  ${c.gray(t)} ${typeColor(e.type)}${dur}${cost}`);
      const detail = traceDetail(e.type, e.payload);
      if (detail) line(`      ${c.gray(detail)}`);
    }
    return 0;
  }

  if (sub === 'rollback') {
    const snaps = SnapshotStore.load(cfg.dataRoot, id);
    const entries = snaps.list();
    if (entries.length === 0) {
      info('本任务没有记录到文件改动。');
      return 0;
    }
    heading(`回滚任务 ${id}`);
    line(`  将恢复 ${entries.filter((e) => !e.skippedReason).length} 个文件。`);
    const bad = snaps.unrecoverable();
    if (bad.length) {
      warn(`${bad.length} 个文件不可回滚：`);
      for (const b of bad) line(`    ${b.originalPath} — ${b.skippedReason}`);
    }
    const trace = cfg.store.loadTrace(id);
    const cmds = trace.filter((t) => t.type === 'tool_call' && t.payload['name'] === 'run_command');
    if (cmds.length) {
      warn(`本次回滚不覆盖 ${cmds.length} 条 shell 命令的副作用：`);
      for (const cmd of cmds.slice(0, 10)) {
        const a = cmd.payload['args'] as Record<string, unknown> | undefined;
        line(`    $ ${String(a?.['command'] ?? '').slice(0, 100)}`);
      }
    }
    if (!args.includes('--yes')) {
      line();
      warn('这是预演。确认无误后加 --yes 执行。');
      return 0;
    }
    const results = snaps.rollbackAll();
    for (const r of results) {
      if (r.ok) ok(`${r.action === 'deleted' ? '删除新建文件' : '恢复'} ${r.path}`);
      else err(`${r.path}：${r.error}`);
    }
    return 0;
  }

  err(`未知子命令 ${sub}。可用：ls / show / trace / rollback`);
  return 1;
}

// ---------------------------------------------------------------------------
// cf usage
// ---------------------------------------------------------------------------

export function usageCommand(cfg: AppConfig, args: string[]): number {
  const days = Number(flag(args, '--days') ?? 30);
  const since = Date.now() - days * 86_400_000;
  const rows = cfg.store.usageSummary(since);
  heading(`用量（最近 ${days} 天）`);
  if (rows.length === 0) {
    info('这段时间没有调用记录。');
    return 0;
  }
  table(
    rows.map((r) => [
      `${r.provider_id}/${r.model_id}`,
      String(r.calls),
      fmtTokens(r.input_tokens),
      fmtTokens(r.output_tokens),
      r.input_tokens > 0 ? `${((r.cached_tokens / r.input_tokens) * 100).toFixed(0)}%` : '—',
      money(r.cost_cny),
    ]),
    ['模型', '调用', '输入', '输出', '缓存命中', '花费'],
  );
  const total = rows.reduce((n, r) => n + r.cost_cny, 0);
  line(`\n  ${c.bold(`合计 ${money(total)}`)}`);

  const fx = cfg.prices.getFx();
  if (rows.some((r) => (cfg.prices.lookup(r.provider_id, r.model_id)?.currency ?? 'CNY') === 'USD')) {
    line(`  ${c.gray(`含美元计价模型，人民币金额按调用时刻汇率固化（当前 ${fx.rate}，来源 ${fx.source}）。`)}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// cf compare
// ---------------------------------------------------------------------------

export async function compareCommand(cfg: AppConfig, args: string[]): Promise<number> {
  const prompt = args.find((a) => !a.startsWith('--') && !isValue(args, a));
  const specs = args.flatMap((a, i) => (a === '-m' || a === '--model' ? [args[i + 1]!] : []));
  if (!prompt || specs.length < 2) {
    err('用法：cf compare "<问题>" -m deepseek/deepseek-v4-pro -m alibaba/qwen3.7-plus');
    return 1;
  }

  const settings = cfg.settings();
  const targets = specs.map((s) => parseModel(s, settings)).filter((t): t is NonNullable<typeof t> => !!t);
  heading(`并排对比（${targets.length} 路）`);

  const results = await Promise.all(
    targets.map(async (t) => {
      const client = cfg.client({ modelId: t.modelId });
      const started = Date.now();
      try {
        const res = await client.collect(t.providerId, {
          modelId: t.modelId,
          messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], createdAt: Date.now() }],
          stream: false,
        });
        const cost = cfg.prices.cost(t.providerId, t.modelId, res.usage);
        cfg.store.recordUsage({
          id: `use_${randomUUID().slice(0, 8)}`,
          timestamp: Date.now(),
          providerId: t.providerId,
          modelId: t.modelId,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          cachedTokens: res.usage.cachedInputTokens,
          reasoningTokens: res.usage.reasoningTokens,
          costOriginal: cost.amountOriginal,
          currency: cost.currency,
          fxRate: cost.fxRate,
          fxSource: cost.fxSource,
          fxFetchedAt: cost.fxFetchedAt,
          costCny: cost.amountCny,
          latencyMs: res.latencyMs,
          status: 'success',
        });
        return {
          target: t,
          text: res.message.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
          usage: res.usage,
          cost: cost.amountCny,
          priced: cost.priced,
          ms: Date.now() - started,
        };
      } catch (e) {
        return { target: t, error: isEngineError(e) ? e.userMessage : String(e), ms: Date.now() - started };
      }
    }),
  );

  for (const r of results) {
    line();
    line(c.bold(`── ${r.target.providerId}/${r.target.modelId} ──`));
    if ('error' in r && r.error) {
      err(r.error);
      continue;
    }
    const rr = r as Extract<typeof r, { text: string }>;
    line(rr.text.trim());
    line(
      c.gray(
        `  ${duration(rr.ms)} · 输入 ${rr.usage.inputTokens} / 输出 ${rr.usage.outputTokens} · ${rr.priced ? money(rr.cost) : '价格未知'}`,
      ),
    );
  }

  const priced = results.filter((r): r is Extract<typeof r, { cost: number }> => 'cost' in r && (r as { priced: boolean }).priced);
  if (priced.length > 1) {
    const cheapest = priced.reduce((a, b) => (a.cost <= b.cost ? a : b));
    const fastest = results
      .filter((r) => !('error' in r && r.error))
      .reduce((a, b) => (a.ms <= b.ms ? a : b));
    line();
    kv('最便宜', `${cheapest.target.providerId}/${cheapest.target.modelId}（${money(cheapest.cost)}）`);
    kv('最快', `${fastest.target.providerId}/${fastest.target.modelId}（${duration(fastest.ms)}）`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// cf chat
// ---------------------------------------------------------------------------

export async function chatCommand(cfg: AppConfig, args: string[]): Promise<number> {
  const settings = cfg.settings();
  const target = parseModel(flag(args, '-m') ?? flag(args, '--model'), settings);
  if (!target) {
    err('未指定模型，且没有默认模型。运行 cf provider add <id> 先配置。');
    return 1;
  }
  const { prompt: ask } = await import('../ui.js');
  const client = cfg.client({ modelId: target.modelId, onWarning: (m) => warn(m) });
  const history: Message[] = [];
  const taskId = `task_${randomUUID().slice(0, 8)}`;
  cfg.store.createTask({
    id: taskId,
    title: '对话',
    goal: '交互式对话',
    mode: 'chat',
    providerId: target.providerId,
    modelId: target.modelId,
    permission: {},
  });

  heading(`对话 · ${target.providerId}/${target.modelId}`);
  line(c.gray('  输入 /exit 退出，/clear 清空上下文，/model <id> 切换模型，/cost 查看花费。'));
  let totalCost = 0;
  let current = target;

  for (;;) {
    const input = await ask('\n> ');
    if (!input) continue;
    if (input === '/exit') break;
    if (input === '/clear') {
      history.length = 0;
      ok('上下文已清空。');
      continue;
    }
    if (input === '/cost') {
      kv('本次会话累计', money(totalCost));
      continue;
    }
    if (input.startsWith('/model ')) {
      const next = parseModel(input.slice(7).trim(), settings);
      if (next) {
        current = next;
        ok(`已切换到 ${next.providerId}/${next.modelId}（上下文保留）`);
      } else err('模型格式应为 provider/model');
      continue;
    }

    history.push({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: input }], createdAt: Date.now() });
    let inReasoning = false;
    const { MessageAssembler } = await import('@confluence/core');
    const asm = new MessageAssembler(current.modelId);
    try {
      for await (const ev of client.stream(current.providerId, { modelId: current.modelId, messages: history })) {
        asm.push(ev);
        if (ev.type === 'reasoning_delta') {
          if (!inReasoning) {
            write(c.gray('\n[思考] '));
            inReasoning = true;
          }
          write(c.gray(ev.text));
        } else if (ev.type === 'text_delta') {
          if (inReasoning) {
            write('\n\n');
            inReasoning = false;
          }
          write(ev.text);
        }
      }
      write('\n');
      const msg = asm.message();
      history.push(msg);
      const cost = cfg.prices.cost(current.providerId, current.modelId, asm.usage);
      totalCost += cost.amountCny;
      line(
        c.gray(
          `  ${asm.usage.inputTokens}→${asm.usage.outputTokens} tokens · ${cost.priced ? money(cost.amountCny) : '价格未知'} · 累计 ${money(totalCost)}`,
        ),
      );
    } catch (e) {
      line();
      err(isEngineError(e) ? e.userMessage : String(e));
    }
  }

  cfg.store.saveMessages(taskId, history);
  cfg.store.updateTask(taskId, { status: 'completed', costCny: totalCost });
  return 0;
}

// ---------------------------------------------------------------------------

function statusColor(s: string): string {
  if (s === 'completed') return c.green(s);
  if (s === 'failed') return c.red(s);
  if (s === 'aborted') return c.yellow(s);
  return c.blue(s);
}

function typeColor(t: string): string {
  const map: Record<string, (s: string) => string> = {
    model_call: c.magenta,
    tool_call: c.blue,
    file_op: c.cyan,
    permission: c.yellow,
    error: c.red,
    checkpoint: c.gray,
    compaction: c.gray,
  };
  return (map[t] ?? ((s: string) => s))(t);
}

function traceDetail(type: string, p: Record<string, unknown>): string {
  if (type === 'model_call') {
    const u = p['usage'] as Usage | undefined;
    return `${String(p['providerId'])}/${String(p['modelId'])} · in ${u?.inputTokens ?? 0} out ${u?.outputTokens ?? 0} · ctx ${String(p['contextTokens'] ?? '?')}`;
  }
  if (type === 'tool_call') return `${String(p['name'])} — ${String(p['summary'] ?? p['error'] ?? '')}`;
  if (type === 'file_op') return `${String(p['op'])} ${String(p['path'])}`;
  if (type === 'permission') return `${String(p['tool'])} → ${String(p['outcome'])}`;
  if (type === 'error') return String((p as { userMessage?: string }).userMessage ?? '');
  if (type === 'compaction') return `折叠 ${String(p['removed'])} 条`;
  return '';
}

function summarizeMessage(m: Message): string {
  return m.content
    .map((b) => {
      if (b.type === 'text') return b.text.replace(/\s+/g, ' ');
      if (b.type === 'tool_call') return `[调用 ${b.name}]`;
      if (b.type === 'tool_result') return `[结果 ${b.content.slice(0, 40)}]`;
      return '[图片]';
    })
    .join(' ');
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

function isValue(args: string[], v: string): boolean {
  const i = args.indexOf(v);
  return i > 0 && (args[i - 1] === '-m' || args[i - 1]!.startsWith('--'));
}

export { detectSandbox };
