#!/usr/bin/env node
import { isEngineError } from '@confluence/core';
import { AppConfig } from './config.js';
import { chatCommand, compareCommand, doctorCommand, taskCommand, usageCommand } from './commands/misc.js';
import { providerCommand, flag } from './commands/provider.js';
import { runCommand } from './commands/run.js';
import { c, err, heading, kv, line, table } from './ui.js';

const VERSION = '0.1.0';

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return help();
  if (cmd === '--version' || cmd === '-v') {
    line(`confluence ${VERSION}`);
    return 0;
  }

  const cfg = new AppConfig();
  try {
    switch (cmd) {
      case 'provider':
        return await providerCommand(cfg, argv.slice(1));
      case 'model':
        return modelCommand(cfg, argv.slice(1));
      case 'run':
        return await runCommand(cfg, argv.slice(1));
      case 'chat':
        return await chatCommand(cfg, argv.slice(1));
      case 'compare':
        return await compareCommand(cfg, argv.slice(1));
      case 'task':
        return taskCommand(cfg, argv.slice(1));
      case 'usage':
        return usageCommand(cfg, argv.slice(1));
      case 'price':
        return priceCommand(cfg, argv.slice(1));
      case 'config':
        return configCommand(cfg, argv.slice(1));
      case 'doctor':
        return doctorCommand(cfg);
      default:
        err(`未知命令 ${cmd}`);
        return help();
    }
  } finally {
    cfg.close();
  }
}

function help(): number {
  line(`${c.bold('confluence')} ${c.gray(VERSION)} — 跨平台多模型 Agent 引擎（MVP）`);
  heading('命令');
  kv('run "<任务>"', '让 Agent 在工作目录里干活（核心命令）', 22);
  kv('chat', '交互式对话，可中途切换模型', 22);
  kv('compare "<问题>"', '同一个问题并排跑多个模型，对比效果与成本', 22);
  kv('provider', '管理服务商：ls / presets / add / set-key / test / rm', 22);
  kv('model ls [id]', '列出某个服务商的模型', 22);
  kv('task', '任务：ls / show / trace / rollback', 22);
  kv('usage', '用量与花费统计', 22);
  kv('price', '价格表：ls / set', 22);
  kv('config', '设置：proxy / fx / default / secret-backend', 22);
  kv('doctor', '自检：沙箱、密钥存储、服务商、汇率', 22);
  heading('快速开始');
  line('  cf provider add deepseek        # 添加服务商并填 Key');
  line('  cf doctor                       # 确认沙箱与密钥存储可用');
  line('  cf run "整理当前目录的 md 文件，生成一个索引"');
  line();
  return 0;
}

function modelCommand(cfg: AppConfig, args: string[]): number {
  const id = args[1] ?? args[0] ?? cfg.settings().defaultProvider;
  if (!id) {
    err('用法：cf model ls <provider-id>');
    return 1;
  }
  if (args[0] === 'add') {
    const [, providerId, modelId] = args;
    const r = providerId ? cfg.getProviderRecord(providerId) : undefined;
    if (!r || !modelId) {
      err('用法：cf model add <provider-id> <model-id>');
      line(`  ${c.gray('用于阿里 Anthropic 端点这类不提供 /v1/models 的服务商。')}`);
      return 1;
    }
    cfg.upsertProvider({ ...r, extraModels: [...new Set([...r.extraModels, modelId])] });
    line(`${c.green('✓')} 已为 ${providerId} 添加模型 ${modelId}`);
    return 0;
  }

  const models = cfg.modelsFor(id);
  if (models.length === 0) {
    err(`服务商 ${id} 没有内置模型列表。`);
    line(`  ${c.gray(`用 cf model add ${id} <model-id> 手动添加。部分服务商（如阿里的 Anthropic 端点）不提供模型列表接口。`)}`);
    return 1;
  }
  heading(`${id} 的模型`);
  for (const m of models) {
    const price = cfg.prices.lookup(id, m.id);
    const tier = price?.tiers[0];
    const priceStr = tier
      ? `${price.currency === 'CNY' ? '¥' : '$'}${tier.input}/${tier.output} 每百万 token${price.verified ? '' : c.yellow(' (未核实)')}`
      : c.gray('价格未知');
    line(`  ${c.bold(m.id.padEnd(24))} ${String(m.contextWindow / 1000).padStart(5)}k  ${priceStr}  ${c.gray(m.tags.join(' '))}`);
  }
  return 0;
}

function priceCommand(cfg: AppConfig, args: string[]): number {
  if (args[0] === 'set') {
    const [, providerId, modelId] = args;
    const input = Number(flag(args, '--input'));
    const output = Number(flag(args, '--output'));
    if (!providerId || !modelId || !Number.isFinite(input) || !Number.isFinite(output)) {
      err('用法：cf price set <provider> <model> --input <元/百万> --output <元/百万> [--cache-read X] [--currency CNY|USD]');
      return 1;
    }
    const cacheRead = Number(flag(args, '--cache-read'));
    const currency = (flag(args, '--currency') ?? 'CNY') as 'CNY' | 'USD';
    const entry = {
      providerId,
      modelId,
      currency,
      tiers: [{ input, output, ...(Number.isFinite(cacheRead) ? { cacheRead } : {}) }],
      verified: true,
      note: '用户手动设置',
    };
    cfg.prices.override(entry);
    const existing = cfg.store.get('priceOverrides', [] as unknown[]);
    cfg.store.set('priceOverrides', [...existing.filter((o) => {
      const oo = o as { providerId: string; modelId: string };
      return !(oo.providerId === providerId && oo.modelId === modelId);
    }), entry]);
    line(`${c.green('✓')} 已覆盖 ${providerId}/${modelId} 的价格`);
    return 0;
  }

  heading('价格表（每百万 token）');
  const rows = cfg.prices.list().map((p) => {
    const t = p.tiers[0]!;
    const sym = p.currency === 'CNY' ? '¥' : '$';
    return [
      `${p.providerId}/${p.modelId}`,
      `${sym}${t.input}`,
      `${sym}${t.output}`,
      t.cacheRead !== undefined ? `${sym}${t.cacheRead}` : '—',
      p.source,
      p.verified ? '' : c.yellow('未核实'),
    ];
  });
  line(`  ${c.gray('价格随时可能变动，不可作为决策依据硬编码。用 cf price set 覆盖。')}`);
  line();
  table(rows, ['模型', '输入', '输出', '缓存命中', '来源', '']);
  return 0;
}

function configCommand(cfg: AppConfig, args: string[]): number {
  const key = args[0];
  const value = args[1];
  if (!key) {
    heading('当前设置');
    const s = cfg.settings();
    kv('默认模型', s.defaultProvider ? `${s.defaultProvider}/${s.defaultModel ?? '?'}` : '未设置');
    kv('代理', s.proxy ?? '未设置');
    kv('密钥后端', cfg.secrets().backend);
    kv('匿名统计', s.telemetry ? '已开启' : '已关闭（默认）');
    kv('数据目录', cfg.dataRoot);
    line();
    line(`  ${c.gray('cf config proxy http://127.0.0.1:7890    设置代理（访问境外服务商通常需要）')}`);
    line(`  ${c.gray('cf config default deepseek/deepseek-v4-pro')}`);
    line(`  ${c.gray('cf config fx 7.15                        手动设置 USD→CNY 汇率')}`);
    return 0;
  }

  switch (key) {
    case 'proxy':
      if (args.includes('--clear')) {
        cfg.saveSettings({ proxy: undefined });
        line(`${c.green('✓')} 已清除代理`);
      } else if (value) {
        cfg.saveSettings({ proxy: value });
        line(`${c.green('✓')} 代理已设为 ${value}`);
        line(`  ${c.gray('注意：这只影响模型 API 出站；Agent 工具的网络访问由任务的 --network 策略单独控制。')}`);
      } else err('用法：cf config proxy <url> | --clear');
      return 0;
    case 'default': {
      if (!value) {
        err('用法：cf config default <provider>/<model>');
        return 1;
      }
      const i = value.indexOf('/');
      if (i === -1) {
        err('格式应为 provider/model');
        return 1;
      }
      cfg.saveSettings({ defaultProvider: value.slice(0, i), defaultModel: value.slice(i + 1) });
      line(`${c.green('✓')} 默认模型已设为 ${value}`);
      return 0;
    }
    case 'fx': {
      const rate = Number(value);
      if (!Number.isFinite(rate) || rate <= 0) {
        err('用法：cf config fx <rate>，例如 cf config fx 7.15');
        return 1;
      }
      const fx = { rate, source: 'user', fetchedAt: Date.now() };
      cfg.store.set('fx', fx);
      cfg.prices.setFx({ from: 'USD', to: 'CNY', ...fx });
      line(`${c.green('✓')} USD→CNY 汇率已设为 ${rate}`);
      line(`  ${c.gray('已记录的历史用量不受影响——每条记录的汇率在调用时刻就已固化。')}`);
      return 0;
    }
    case 'secret-backend': {
      if (value !== 'env' && value !== 'keychain' && value !== 'encrypted') {
        err('用法：cf config secret-backend <env|keychain|encrypted>');
        return 1;
      }
      cfg.saveSettings({ secretBackend: value });
      line(`${c.green('✓')} 密钥后端已设为 ${value}`);
      if (value === 'encrypted') line(`  ${c.gray("需要设置主密码：export CF_MASTER_PASSWORD='...'")}`);
      return 0;
    }
    case 'telemetry':
      cfg.saveSettings({ telemetry: value === 'on' });
      line(`${c.green('✓')} 匿名统计已${value === 'on' ? '开启' : '关闭'}`);
      return 0;
    default:
      err(`未知设置项 ${key}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    if (isEngineError(e)) {
      err(e.userMessage);
      if (e.technical && process.env['CF_DEBUG']) line(c.gray(e.technical));
    } else {
      err(String(e));
      if (process.env['CF_DEBUG'] && e instanceof Error) line(c.gray(e.stack ?? ''));
    }
    process.exit(1);
  });
