import { PROVIDER_PRESETS, findPreset, isEngineError, maskKey } from '@confluence/core';
import type { AppConfig, ProviderRecord } from '../config.js';
import { c, err, heading, info, kv, line, ok, prompt, table, warn } from '../ui.js';

export async function providerCommand(cfg: AppConfig, args: string[]): Promise<number> {
  const sub = args[0] ?? 'ls';
  switch (sub) {
    case 'ls':
      return listProviders(cfg);
    case 'presets':
      return listPresets(args.includes('--unverified'));
    case 'add':
      return addProvider(cfg, args.slice(1));
    case 'set-key':
      return setKey(cfg, args.slice(1));
    case 'test':
      return testProvider(cfg, args.slice(1));
    case 'rm':
      return removeProvider(cfg, args.slice(1));
    case 'enable':
    case 'disable':
      return toggleProvider(cfg, args.slice(1), sub === 'enable');
    default:
      err(`未知子命令 ${sub}。可用：ls / presets / add / set-key / test / rm / enable / disable`);
      return 1;
  }
}

function listProviders(cfg: AppConfig): number {
  const records = cfg.listProviders();
  if (records.length === 0) {
    warn('尚未配置任何服务商。');
    line(`  运行 ${c.cyan('cf provider presets')} 查看内置预设，${c.cyan('cf provider add deepseek')} 添加。`);
    return 0;
  }
  const secrets = cfg.secrets();
  heading('已配置的服务商');
  table(
    records.map((r) => {
      const key = secrets.get(r.id);
      const status = !r.enabled ? c.gray('已禁用') : key ? c.green('就绪') : c.yellow('缺少 Key');
      return [r.id, r.displayName, r.protocol, status, key ? maskKey(key) : '—'];
    }),
    ['ID', '名称', '协议', '状态', 'API Key'],
  );
  const s = cfg.settings();
  if (s.defaultProvider) line(`\n  默认：${c.cyan(`${s.defaultProvider}/${s.defaultModel ?? '?'}`)}`);
  return 0;
}

function listPresets(includeUnverified: boolean): number {
  heading('内置服务商预设');
  const rows = PROVIDER_PRESETS.filter((p) => p.verified || includeUnverified).map((p) => [
    p.id,
    p.displayName,
    p.endpoints.map((e) => e.protocol.replace('openai_chat', 'openai')).join('+'),
    p.models.length ? `${p.models.length} 个模型` : c.gray('需手填'),
    p.verified ? '' : c.yellow('未验证'),
  ]);
  table(rows, ['ID', '名称', '协议', '模型', '']);
  if (!includeUnverified) {
    const n = PROVIDER_PRESETS.filter((p) => !p.verified).length;
    if (n) line(`\n  ${c.gray(`另有 ${n} 个未验证预设（端点或定价未经一手核实），用 --unverified 查看。`)}`);
  }
  return 0;
}

async function addProvider(cfg: AppConfig, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    err('用法：cf provider add <preset-id> [--protocol openai|anthropic] [--base-url URL]');
    return 1;
  }
  const preset = findPreset(id);
  const protocolArg = flag(args, '--protocol');
  const baseUrlArg = flag(args, '--base-url');

  let record: ProviderRecord;
  if (preset) {
    if (!preset.verified && !args.includes('--unverified')) {
      err(`预设 ${id} 尚未经一手核实（端点或定价未确认），不建议作为内置使用。`);
      line(`  ${c.gray('确要添加请加 --unverified，或用自定义端点：cf provider add custom --base-url ...')}`);
      return 1;
    }
    const endpoint =
      preset.endpoints.find((e) => e.protocol.startsWith(protocolArg ?? '')) ?? preset.endpoints[0]!;
    record = {
      id: preset.id,
      presetId: preset.id,
      displayName: preset.displayName,
      protocol: endpoint.protocol,
      baseUrl: baseUrlArg ?? endpoint.baseUrl,
      authHeader: preset.authHeader,
      enabled: true,
      extraModels: [],
      ...(preset.local ? { local: true } : {}),
    };
  } else {
    if (!baseUrlArg) {
      err(`没有名为 ${id} 的预设。自定义端点需要 --base-url，例如：`);
      line(`  cf provider add my-gateway --base-url http://localhost:3000/v1 --protocol openai`);
      return 1;
    }
    record = {
      id,
      displayName: flag(args, '--name') ?? id,
      protocol: (protocolArg === 'anthropic' ? 'anthropic' : 'openai_chat') as ProviderRecord['protocol'],
      baseUrl: baseUrlArg,
      authHeader: protocolArg === 'anthropic' ? 'x-api-key' : 'bearer',
      enabled: true,
      extraModels: [],
    };
  }

  cfg.upsertProvider(record);
  ok(`已添加服务商 ${c.bold(record.id)}（${record.displayName}）`);
  kv('端点', record.baseUrl);
  kv('协议', record.protocol);

  if (preset?.quirks.notes.length) {
    line();
    for (const n of preset.quirks.notes) info(n);
  }

  if (record.local) {
    ok('本地服务商无需 API Key。');
  } else {
    line();
    if (preset) info(`获取 API Key：${preset.consoleUrl}`);
    const key = await prompt('现在输入 API Key（直接回车跳过）：', { hidden: true });
    if (key) {
      try {
        cfg.secrets().set(record.id, key);
        ok(`密钥已保存（后端：${cfg.secrets().backend}）`);
      } catch (e) {
        err(isEngineError(e) ? e.userMessage : String(e));
        return 1;
      }
    } else {
      info(`稍后可运行：cf provider set-key ${record.id}`);
    }
  }

  if (!cfg.settings().defaultProvider) {
    const firstModel = cfg.modelsFor(record.id)[0];
    cfg.saveSettings({
      defaultProvider: record.id,
      ...(firstModel ? { defaultModel: firstModel.id } : {}),
    });
    info(`已设为默认服务商${firstModel ? `，默认模型 ${firstModel.id}` : ''}。`);
  }
  return 0;
}

async function setKey(cfg: AppConfig, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    err('用法：cf provider set-key <provider-id>');
    return 1;
  }
  if (!cfg.getProviderRecord(id)) {
    err(`未配置服务商 ${id}。先运行 cf provider add ${id}`);
    return 1;
  }
  const key = await prompt('API Key：', { hidden: true });
  if (!key) {
    warn('未输入，已取消。');
    return 1;
  }
  try {
    cfg.secrets().set(id, key);
    ok(`已保存 ${id} 的密钥（后端：${cfg.secrets().backend}）`);
    return 0;
  } catch (e) {
    err(isEngineError(e) ? e.userMessage : String(e));
    return 1;
  }
}

async function testProvider(cfg: AppConfig, args: string[]): Promise<number> {
  const id = args[0] ?? cfg.settings().defaultProvider;
  if (!id) {
    err('用法：cf provider test <provider-id>');
    return 1;
  }
  const record = cfg.getProviderRecord(id);
  if (!record) {
    err(`未配置服务商 ${id}`);
    return 1;
  }
  const modelId = flag(args, '--model') ?? cfg.modelsFor(id)[0]?.id;
  if (!modelId) {
    err(`服务商 ${id} 没有可用模型。用 --model 指定一个模型名。`);
    return 1;
  }

  info(`正在测试 ${id} / ${modelId} …`);
  const client = cfg.client({ modelId, onWarning: (m) => warn(m) });
  const started = Date.now();
  try {
    const res = await client.collect(id, {
      modelId,
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '回复两个字：可用' }], createdAt: Date.now() }],
      maxOutputTokens: 32,
      stream: false,
    });
    const text = res.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok(`连接成功（${Date.now() - started}ms）`);
    kv('模型响应', text.trim().slice(0, 60) || '(空)');
    kv('token', `输入 ${res.usage.inputTokens} / 输出 ${res.usage.outputTokens}`);
    const cost = cfg.prices.cost(id, modelId, res.usage);
    kv('本次费用', cost.priced ? `¥${cost.amountCny.toFixed(6)}` : '价格未知（未在价格表中）');
    return 0;
  } catch (e) {
    if (isEngineError(e)) {
      err(e.userMessage);
      if (e.technical) line(`  ${c.gray(e.technical.slice(0, 300))}`);
    } else {
      err(String(e));
    }
    return 1;
  }
}

function removeProvider(cfg: AppConfig, args: string[]): number {
  const id = args[0];
  if (!id) {
    err('用法：cf provider rm <provider-id>');
    return 1;
  }
  cfg.removeProvider(id);
  ok(`已移除 ${id}（同时删除已保存的密钥）`);
  return 0;
}

function toggleProvider(cfg: AppConfig, args: string[], enabled: boolean): number {
  const id = args[0];
  const r = id ? cfg.getProviderRecord(id) : undefined;
  if (!r) {
    err(`未配置服务商 ${id ?? ''}`);
    return 1;
  }
  cfg.upsertProvider({ ...r, enabled });
  ok(`${id} 已${enabled ? '启用' : '禁用'}`);
  return 0;
}

export function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}
