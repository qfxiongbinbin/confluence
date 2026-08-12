/**
 * Built-in provider presets.
 *
 * Rule from the PRD (F1.1): a provider only ships as "built-in" when its
 * baseURL, protocol and auth are confirmed first-hand. Anything unverified
 * stays a custom endpoint. `verified: false` entries are here for reference
 * and are hidden from `cf provider add` unless --unverified is passed.
 *
 * Prices live in pricing.ts and are remote-updatable — never hardcode them
 * into decision logic.
 */

import { DEFAULT_QUIRKS, mergeQuirks, type ProviderQuirks, type WireProtocol } from './quirks.js';

export interface ModelPreset {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: {
    vision?: boolean;
    tools?: boolean;
    thinking?: boolean;
    promptCache?: boolean;
    structuredOutput?: boolean;
  };
  tags?: string[];
  /** Per-model quirk overrides (e.g. Kimi k2.7-code's mandatory thinking). */
  quirkOverrides?: Partial<ProviderQuirks>;
}

export interface ProviderPreset {
  id: string;
  displayName: string;
  /** Which wire protocols this provider exposes, in preference order. */
  endpoints: { protocol: WireProtocol; baseUrl: string; label: string }[];
  authHeader: 'bearer' | 'x-api-key';
  quirks: ProviderQuirks;
  models: ModelPreset[];
  /** Where to get a key. Shown in onboarding (F10.1). */
  consoleUrl: string;
  /** false => only reachable via `provider add --custom`. */
  verified: boolean;
  region: string;
  /** Set for local runtimes: no key needed, offline-capable. */
  local?: boolean;
}

const q = (o: Parameters<typeof mergeQuirks>[1]) => mergeQuirks(DEFAULT_QUIRKS, o);

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // -------------------------------------------------------------------------
  {
    id: 'deepseek',
    displayName: 'DeepSeek 深度求索',
    endpoints: [
      { protocol: 'openai_chat', baseUrl: 'https://api.deepseek.com/v1', label: 'OpenAI 兼容' },
      { protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', label: 'Anthropic 兼容' },
    ],
    authHeader: 'bearer',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    verified: true,
    region: 'cn',
    quirks: q({
      reasoning: { field: 'reasoning_content', mustEchoBack: true, echoOnlyWithTools: true },
      thinking: { kind: 'reasoning_effort', map: { low: 'low', medium: 'high', high: 'xhigh', max: 'max' } },
      temperature: { min: 0, max: 2, default: 1, ignoredWhenThinking: true },
      // DeepSeek meters concurrency, not RPM. Backoff strategy differs.
      rateLimit: { kind: 'concurrency', limit: 500 },
      supportsPromptCache: true,
      supportsPrefixCompletion: true,
      notes: [
        '思维链走 reasoning_content 字段，多轮 + 工具调用时必须原样回传，否则 400。',
        '思考模式下 temperature / top_p / presence_penalty / frequency_penalty 全部静默失效。',
        '按并发限流（v4-pro 500 / v4-flash 2500），不是 RPM/TPM。',
        '官方已预告近期整体上调定价，成本测算需留缓冲。',
      ],
    }),
    models: [
      {
        id: 'deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        contextWindow: 1_000_000,
        maxOutput: 384_000,
        capabilities: { tools: true, thinking: true, promptCache: true, structuredOutput: true },
        tags: ['强推理', '长上下文'],
      },
      {
        id: 'deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        contextWindow: 1_000_000,
        maxOutput: 384_000,
        capabilities: { tools: true, thinking: true, promptCache: true, structuredOutput: true },
        tags: ['便宜', '长上下文'],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'alibaba',
    displayName: '阿里云百炼（通义千问）',
    endpoints: [
      {
        protocol: 'openai_chat',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        label: 'OpenAI 兼容（旧域名，仍可用）',
      },
      {
        protocol: 'anthropic',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        label: 'Anthropic 兼容',
      },
    ],
    authHeader: 'bearer',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    verified: true,
    region: 'cn-beijing',
    quirks: q({
      thinking: {
        kind: 'enable_thinking_flag',
        flagField: 'enable_thinking',
        budgetField: 'thinking_budget',
        budgetMap: { low: 1024, medium: 8192, high: 32768, max: 131072 },
      },
      temperature: { min: 0, max: 2, default: 1 },
      rateLimit: { kind: 'rpm_tpm', rpm: 30_000, tpm: 5_000_000, sharedAcrossKeys: true },
      supportsPromptCache: true,
      notes: [
        'OpenAI 兼容端点已迁移到 workspace 维度的新域名 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1，旧域名仍可用但建议迁移（用 --base-url 覆盖）。',
        'Anthropic 兼容端点不提供 /v1/models，模型名需手动添加。',
        '限流按主账号维度合并计算：所有 RAM 子账号、业务空间、API Key 共享额度。',
        '部分能力分地域：Function Calling 等在北京全量，海外区域有裁剪。',
      ],
    }),
    models: [
      {
        id: 'qwen3.7-flash',
        displayName: '通义千问 3.7 Flash',
        contextWindow: 1_000_000,
        maxOutput: 131_072,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['便宜', '视觉', '长上下文'],
      },
      {
        id: 'qwen3.7-plus',
        displayName: '通义千问 3.7 Plus',
        contextWindow: 1_000_000,
        maxOutput: 131_072,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['均衡', '视觉', '长上下文'],
      },
      {
        id: 'qwen3.8-max',
        displayName: '通义千问 3.8 Max',
        contextWindow: 1_000_000,
        maxOutput: 131_072,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['旗舰', '视觉', '长上下文'],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'zhipu',
    displayName: '智谱 AI（GLM）',
    endpoints: [
      { protocol: 'openai_chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', label: 'OpenAI 兼容' },
      { protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', label: 'Anthropic 兼容' },
    ],
    authHeader: 'bearer',
    consoleUrl: 'https://bigmodel.cn/usercenter/apikeys',
    verified: true,
    region: 'cn',
    quirks: q({
      thinking: { kind: 'enable_thinking_flag', flagField: 'thinking' },
      // The one that bites everyone: interval is (0,1) and 0 is rejected.
      temperature: { min: 0, max: 1, exclusiveMin: true, exclusiveMax: true, default: 0.6 },
      supportsPromptCache: true,
      notes: [
        'temperature 区间是 (0,1) 且不支持 0——"确定性输出"这类需求在 GLM 上无法直接满足，引擎会自动修正为最接近的合法值。',
        '默认 temperature 为 0.6，与 OpenAI 的 1.0 不同。',
        '官方定价页为 JS 渲染，内置价格来自二手来源，建议自行核实后用 `cf price set` 覆盖。',
      ],
    }),
    models: [
      {
        id: 'glm-5.2',
        displayName: 'GLM-5.2',
        contextWindow: 200_000,
        maxOutput: 128_000,
        capabilities: { tools: true, thinking: true, promptCache: true, structuredOutput: true },
        tags: ['旗舰', '编码'],
      },
      {
        id: 'glm-5-turbo',
        displayName: 'GLM-5 Turbo',
        contextWindow: 200_000,
        maxOutput: 128_000,
        capabilities: { tools: true, thinking: true, structuredOutput: true },
        tags: ['便宜'],
      },
      {
        id: 'glm-5v-turbo',
        displayName: 'GLM-5V Turbo（多模态）',
        contextWindow: 200_000,
        maxOutput: 128_000,
        capabilities: { tools: true, vision: true, structuredOutput: true },
        tags: ['视觉'],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'moonshot',
    displayName: '月之暗面 Kimi',
    endpoints: [
      { protocol: 'openai_chat', baseUrl: 'https://api.moonshot.cn/v1', label: 'OpenAI 兼容' },
      { protocol: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic', label: 'Anthropic 兼容' },
    ],
    authHeader: 'bearer',
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
    verified: true,
    region: 'cn',
    quirks: q({
      thinking: { kind: 'enable_thinking_flag', flagField: 'enable_thinking' },
      temperature: { min: 0, max: 2, default: 0.6 },
      // Tier0 (no top-up) is brutal: 1 concurrent, 3 RPM. New users hit 429 instantly.
      rateLimit: { kind: 'tiered', tier: 'Tier0', rpm: 3, concurrency: 1 },
      supportsPromptCache: true,
      supportsPrefixCompletion: true,
      notes: [
        '未充值的 Tier0 限速极严：并发 1 / RPM 3。首次接入几乎必然撞 429，充值 ¥50 升到 Tier1 后为并发 50 / RPM 200。',
        'kimi-k2.7-code 必须显式开启思考，否则直接 400（引擎已自动处理）。',
        'kimi-k3 默认开启思考，输出 ¥100/M 是国内最贵，不建议设为默认模型。',
        'moonshot-v1-* 系列为 legacy，预计 2026-08-31 下线。',
      ],
    }),
    models: [
      {
        id: 'kimi-k2.7-code',
        displayName: 'Kimi K2.7 Code',
        contextWindow: 262_144,
        maxOutput: 131_072,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['编码'],
        // The quirk that makes this model 400 without thinking enabled.
        quirkOverrides: { thinking: { kind: 'always_on' } },
      },
      {
        id: 'kimi-k3',
        displayName: 'Kimi K3',
        contextWindow: 1_048_576,
        maxOutput: 131_072,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['旗舰', '长上下文', '贵'],
        quirkOverrides: { thinking: { kind: 'always_on' } },
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'openai',
    displayName: 'OpenAI',
    endpoints: [{ protocol: 'openai_chat', baseUrl: 'https://api.openai.com/v1', label: 'Chat Completions' }],
    authHeader: 'bearer',
    consoleUrl: 'https://platform.openai.com/api-keys',
    verified: true,
    region: 'global',
    quirks: q({
      thinking: { kind: 'reasoning_effort', map: { low: 'low', medium: 'medium', high: 'high', max: 'high' } },
      temperature: { min: 0, max: 2, default: 1 },
      rateLimit: { kind: 'tiered', tier: 'unknown' },
      supportsPromptCache: true,
      notes: ['国内访问通常需要配置代理：cf config proxy http://127.0.0.1:7890'],
    }),
    models: [
      {
        id: 'gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        contextWindow: 400_000,
        maxOutput: 128_000,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['便宜'],
      },
      {
        id: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        contextWindow: 400_000,
        maxOutput: 128_000,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['均衡'],
      },
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        contextWindow: 400_000,
        maxOutput: 128_000,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['旗舰'],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    endpoints: [{ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', label: 'Messages API' }],
    authHeader: 'x-api-key',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    verified: true,
    region: 'global',
    quirks: q({
      thinking: {
        kind: 'thinking_budget_object',
        field: 'thinking',
        budgetMap: { low: 2048, medium: 8192, high: 16384, max: 32768 },
      },
      temperature: { min: 0, max: 1, default: 1 },
      supportsPromptCache: true,
      notes: [
        'Sonnet 5 于 2026-09-01 从 $2/$10 涨到 $3/$15，价格表需及时更新。',
        '国内访问通常需要配置代理。',
      ],
    }),
    models: [
      {
        id: 'claude-haiku-4-5',
        displayName: 'Claude Haiku 4.5',
        contextWindow: 200_000,
        maxOutput: 64_000,
        capabilities: { tools: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['便宜', '快'],
      },
      {
        id: 'claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
        contextWindow: 200_000,
        maxOutput: 64_000,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['均衡', '编码'],
      },
      {
        id: 'claude-opus-5',
        displayName: 'Claude Opus 5',
        contextWindow: 200_000,
        maxOutput: 64_000,
        capabilities: { tools: true, thinking: true, vision: true, promptCache: true, structuredOutput: true },
        tags: ['旗舰'],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'ollama',
    displayName: 'Ollama（本地）',
    endpoints: [{ protocol: 'openai_chat', baseUrl: 'http://localhost:11434/v1', label: 'OpenAI 兼容' }],
    authHeader: 'bearer',
    consoleUrl: 'https://ollama.com/download',
    verified: true,
    region: 'local',
    local: true,
    quirks: q({
      thinking: { kind: 'none' },
      temperature: { min: 0, max: 2, default: 0.8 },
      // Documented gaps in Ollama's OpenAI compatibility layer.
      unsupportedParams: ['logprobs', 'logit_bias', 'tool_choice', 'n', 'user'],
      imageInput: 'base64_only',
      rateLimit: { kind: 'unknown' },
      // Not documented as supported; we don't send params we haven't confirmed.
      supportsParallelToolCalls: false,
      notes: [
        '图片必须 base64，不接受 URL（引擎会自动转换）。',
        '不支持 logprobs / logit_bias / tool_choice / n / user，引擎会静默剔除。',
        '并行工具调用未确认支持，引擎不发送 parallel_tool_calls 参数。',
        'API Key 必填但被忽略，填任意值即可。',
        '完全离线可用。',
      ],
    }),
    models: [],
  },

  // -------------------------------------------------------------------------
  {
    id: 'lmstudio',
    displayName: 'LM Studio（本地）',
    endpoints: [{ protocol: 'openai_chat', baseUrl: 'http://localhost:1234/v1', label: 'OpenAI 兼容' }],
    authHeader: 'bearer',
    consoleUrl: 'https://lmstudio.ai/',
    verified: true,
    region: 'local',
    local: true,
    quirks: q({ thinking: { kind: 'none' }, rateLimit: { kind: 'unknown' } }),
    models: [],
  },

  // -------------------------------------------------------------------------
  // Verified endpoints, but kept out of the built-in list until first-hand
  // confirmation — see PRD F1.1 "准入条件".
  {
    id: 'siliconflow',
    displayName: '硅基流动 SiliconFlow',
    endpoints: [{ protocol: 'openai_chat', baseUrl: 'https://api.siliconflow.cn/v1', label: 'OpenAI 兼容' }],
    authHeader: 'bearer',
    consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
    verified: true,
    region: 'cn',
    quirks: q({
      thinking: {
        kind: 'enable_thinking_flag',
        flagField: 'enable_thinking',
        budgetField: 'thinking_budget',
        budgetMap: { low: 1024, medium: 8192, high: 16384, max: 32768 },
      },
      rateLimit: { kind: 'tiered', tier: 'L0', rpm: 1000 },
      notes: ['thinking_budget 取值范围 128–32768。', '内置价格表未覆盖，请用 `cf price set` 自行维护。'],
    }),
    models: [],
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter（聚合网关）',
    endpoints: [
      { protocol: 'openai_chat', baseUrl: 'https://openrouter.ai/api/v1', label: 'OpenAI 兼容' },
      { protocol: 'anthropic', baseUrl: 'https://openrouter.ai/api/v1', label: 'Anthropic 兼容' },
    ],
    authHeader: 'bearer',
    consoleUrl: 'https://openrouter.ai/keys',
    verified: true,
    region: 'global',
    quirks: q({ notes: ['模型与价格由网关侧决定，`cf model sync` 可自动拉取。'] }),
    models: [],
  },
  {
    id: 'volcengine',
    displayName: '火山方舟（豆包）',
    endpoints: [{ protocol: 'openai_chat', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', label: 'OpenAI 兼容' }],
    authHeader: 'bearer',
    consoleUrl: 'https://console.volcengine.com/ark',
    verified: false, // Seed-2.1 pricing + default RPM/TPM unconfirmed
    region: 'cn-beijing',
    quirks: q({
      requiresConsoleActivation: true,
      notes: [
        '必须先在控制台「开通管理」里显式激活模型才能调用——这是最常见的接入失败原因。',
        'model 参数可用模型名或 Endpoint ID（ep-xxx）。',
        'Seed-2.1 系列定价与默认 RPM/TPM 尚未核实，暂列为未验证。',
      ],
    }),
    models: [],
  },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

export function findModelPreset(providerId: string, modelId: string): ModelPreset | undefined {
  return findPreset(providerId)?.models.find((m) => m.id === modelId);
}

/** Quirks for a given model = provider quirks + per-model overrides. */
export function resolveQuirks(preset: ProviderPreset, modelId: string): ProviderQuirks {
  const m = preset.models.find((x) => x.id === modelId);
  if (!m?.quirkOverrides) return preset.quirks;
  return mergeQuirks(preset.quirks, m.quirkOverrides);
}
