import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  AgentRunner,
  KeychainSecretStore,
  PermissionEngine,
  ToolRegistry,
  detectSandbox,
  loadMcpTools,
  type AgentEvent,
  type AgentRunOptions,
  type Message,
  type PermissionAnswer,
  type PermissionRequest,
  type RetryNotice,
} from '@confluence/core';
import type { AppConfig } from '../config.js';
import { err } from '../ui.js';
import {
  buildProfile,
  loadProjectMcp,
  mergeMcpConfigs,
  parseModel,
  recordUsage,
  systemPrompt,
} from '../commands/run.js';
import { renderBanner } from './banner.js';
import { ConfirmDrawer } from './confirm.js';
import { decodeKey, InputBuffer } from './input.js';
import { Screen, type StatusBar } from './screen.js';
import { FG, paint, setColorEnabled } from './theme.js';
import { Term } from './term.js';
import { VERSION } from '../version.js';

const DOUBLE_CTRL_C_MS = 1_200;
const PASTE_END = Buffer.from('\u001b[201~');

interface SlashCommand {
  name: string;
  desc: string;
  /** 需要参数的命令，Tab 只补全命令名并留一个空格。 */
  takesArg?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', desc: '查看可用命令与按键' },
  { name: '/model', desc: '选择/切换模型', takesArg: true },
  { name: '/cost', desc: '查看本次 token 与累计花费' },
  { name: '/clear', desc: '清空输出区' },
  { name: '/exit', desc: '退出 TUI' },
];

export async function replCommand(cfg: AppConfig): Promise<number> {
  const initialTarget = parseModel(undefined, cfg.settings());
  if (!initialTarget) {
    err('未指定模型，且没有默认模型。运行 cf provider add <id> 先配置一个。');
    return 1;
  }
  const providerRecord = cfg.getProviderRecord(initialTarget.providerId);
  if (!providerRecord) {
    err(`未配置服务商 ${initialTarget.providerId}。运行 cf provider add ${initialTarget.providerId}`);
    return 1;
  }
  // 记录存在还不够：client() 会静默跳过「无密钥/已禁用」的服务商，
  // 等到提交任务才报「未知服务商」，提示具有误导性。这里提前校验。
  if (!providerRecord.enabled) {
    err(`服务商 ${initialTarget.providerId} 已禁用。运行 cf provider test ${initialTarget.providerId} 查看详情。`);
    return 1;
  }
  if (!cfg.client({ modelId: initialTarget.modelId }).getProvider(initialTarget.providerId)) {
    err(`服务商 ${initialTarget.providerId} 没有可用密钥。运行 cf provider set-key ${initialTarget.providerId} 配置后重试。`);
    return 1;
  }

  const term = new Term();
  // 符号先行、颜色其次：NO_COLOR / 非 TTY 下只保留装订线符号，内容类别仍可辨
  setColorEnabled(process.stdout.isTTY === true && !process.env['NO_COLOR']);
  const input = new InputBuffer();
  const screen = new Screen(term.size());
  const workingDir = resolve(process.cwd());
  const profile = buildProfile(workingDir, []);
  const permissions = new PermissionEngine(profile, workingDir, cfg.dataRoot);
  const tools = new ToolRegistry();
  let target = initialTarget;
  let messages: Message[] = [];
  let cumulativeCost = 0;
  let runCost = 0;
  let runTokensIn = 0;
  let runTokensOut = 0;
  let activeController: AbortController | undefined;
  let activeRun: Promise<void> | undefined;
  let lastCtrlCAt = 0;
  let exiting = false;
  let pasteMode = false;
  let pendingInput = Buffer.alloc(0);
  let inputAttached = false;
  let altScreenEntered = false;
  let rawModeEntered = false;
  let exitCode = 0;
  // —— 模型选择器 ——
  let pickerOptions: { providerId: string; modelId: string }[] = [];
  let pickerIndex = 0;
  let pickerOpen = false;
  // —— 命令提示 ——
  let hintsHidden = false; // 用户按 Esc 主动隐藏，直到输入再次变化
  let hintIndex = 0;
  // —— 限流退避倒计时 / 运行耗时秒表 ——
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let runStartedAt = 0;
  let resolveExit: (() => void) | undefined;
  const exitRequested = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise;
  });

  // —— 横幅信息 ——
  const usableClient = cfg.client({ modelId: initialTarget.modelId });
  const hasUsableProvider = usableClient.listProviders().length > 0;
  const countSwitchableModels = (): number => {
    let count = 0;
    for (const record of cfg.listProviders()) {
      if (!record.enabled || !usableClient.getProvider(record.id)) continue;
      count += cfg.modelsFor(record.id).length;
    }
    return count;
  };
  const sandboxCapability = detectSandbox();
  const sandboxKind: 'seatbelt' | 'bubblewrap' | undefined =
    sandboxCapability.available &&
    (sandboxCapability.backend === 'seatbelt' || sandboxCapability.backend === 'bubblewrap')
      ? sandboxCapability.backend
      : undefined;
  const secretBackendLabel = (): string | undefined => {
    const prefer = cfg.settings().secretBackend;
    if (prefer) return prefer;
    return KeychainSecretStore.available() ? 'keychain（自动）' : 'env 兜底';
  };

  const status = (): StatusBar => ({
    model: `${target.providerId}/${target.modelId}`,
    tokensIn: runTokensIn,
    tokensOut: runTokensOut,
    costCny: cumulativeCost + runCost,
    mode: profile.mode,
    running: activeController !== undefined,
    elapsedSec: activeController && runStartedAt ? Math.floor((Date.now() - runStartedAt) / 1000) : undefined,
  });

  /** 输入以 / 开头且单行时，列出前缀匹配的命令；否则关闭提示。 */
  const syncHints = () => {
    const value = input.value;
    if (hintsHidden || !value.startsWith('/') || value.includes('\n')) {
      screen.setHints(undefined);
      return;
    }
    const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(value.split(' ')[0]!));
    if (matches.length === 0) {
      screen.setHints(undefined);
      return;
    }
    hintIndex = Math.min(hintIndex, matches.length - 1);
    screen.setHints({ items: matches.map((c) => `${c.name} — ${c.desc}`), index: hintIndex });
  };

  const hintMatches = () => {
    const typed = input.value.split(' ')[0]!;
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
  };

  const redraw = () => {
    screen.setStatus(status());
    syncHints();
    term.hideCursor();
    term.write(screen.render(input.value, input.cursorOffset));
    term.showCursor();
  };

  const requestExit = (code = 0) => {
    if (exiting) return;
    exiting = true;
    exitCode = code;
    if (drawer.open) drawer.close();
    if (pendingPermission || reasonMode) {
      reasonMode = false;
      settlePermission({ decision: 'deny' });
    }
    clearRetryTimer();
    clearTickTimer();
    activeController?.abort();
    resolveExit?.();
  };

  const restoreTerminal = () => {
    if (rawModeEntered) {
      term.exitRawMode();
      rawModeEntered = false;
    }
    if (altScreenEntered) {
      term.exitAltScreen();
      altScreenEntered = false;
    }
    term.showCursor();
  };

  let removeDataListener = () => {};
  const detachInput = () => {
    if (!inputAttached) return;
    removeDataListener();
    inputAttached = false;
  };

  const attachInput = () => {
    if (inputAttached || exiting) return;
    removeDataListener = term.onData(onData);
    inputAttached = true;
  };

  // —— 权限确认抽屉：不退 raw mode、不清屏，浮层让位、上文不丢 ——
  // workingDir 传进去，抽屉才能在风险标签后缀里区分「工作目录内 / 外」
  const drawer = new ConfirmDrawer(workingDir);
  let pendingPermission: ((answer: PermissionAnswer) => void) | undefined;
  let reasonMode = false;
  const defaultPrompt = () => `${paint(FG.cyan, '>')} `;

  const settlePermission = (answer: PermissionAnswer) => {
    screen.setOverlay(undefined);
    screen.setInputPrompt(defaultPrompt());
    pendingPermission?.(answer);
    pendingPermission = undefined;
  };

  const permissionResolver = (request: PermissionRequest): Promise<PermissionAnswer> =>
    new Promise<PermissionAnswer>((resolve) => {
      pendingPermission = resolve;
      reasonMode = false;
      drawer.show(request, request.affects.length > 3);
      screen.setOverlay(drawer.render(term.size().cols));
      redraw();
    });

  // —— 限流退避：第二行倒计时每秒原地刷新，不逐秒新增行 ——
  const clearRetryTimer = () => {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = undefined;
    }
  };

  const clearTickTimer = () => {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };

  const showRetryCountdown = (notice: RetryNotice) => {
    clearRetryTimer();
    const total = Math.max(1, Math.ceil(notice.waitMs / 1000));
    screen.pushKind('warn', `限流 ${notice.code} · ${notice.providerId}`);
    screen.pushKind('muted', `第 ${notice.attempt} 次重试，${total}s 后继续  ^C 放弃`);
    const deadline = Date.now() + notice.waitMs;
    retryTimer = setInterval(() => {
      const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      screen.replaceLast(`第 ${notice.attempt} 次重试，${remain}s 后继续  ^C 放弃`, 'muted');
      redraw();
      if (remain <= 0) clearRetryTimer();
    }, 1_000);
    redraw();
  };

  const runTurn = async (goal: string): Promise<void> => {
    const taskId = `task_${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    activeController = controller;
    runTokensIn = 0;
    runTokensOut = 0;
    runCost = 0;
    runStartedAt = Date.now();
    clearRetryTimer();
    // 运行期间每秒重绘一次：状态栏的耗时秒数才能走起来
    if (!tickTimer) tickTimer = setInterval(() => redraw(), 1_000);
    screen.pushKind('user', goal);
    redraw();

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

    const userMessage: Message = {
      id: `msg_${randomUUID().slice(0, 8)}`,
      role: 'user',
      content: [{ type: 'text', text: goal }],
      createdAt: Date.now(),
    };
    const turnMessages = [...messages, userMessage];
    const turnTarget = { ...target };
    const client = cfg.client({
      modelId: turnTarget.modelId,
      onWarning: (message) => {
        screen.pushKind('warn', message);
        redraw();
      },
      onRetry: showRetryCountdown,
    });
    const runner = new AgentRunner(client, tools, permissions, cfg.prices, permissionResolver);
    const options: AgentRunOptions = {
      taskId,
      goal,
      providerId: turnTarget.providerId,
      modelId: turnTarget.modelId,
      system: systemPrompt(workingDir, profile),
      workingDir,
      dataRoot: cfg.dataRoot,
      contextWindow: cfg.contextWindowFor(turnTarget.providerId, turnTarget.modelId),
      maxSteps: 40,
      signal: controller.signal,
    };
    const generator = runner.run(turnMessages, options);
    let reasoningShown = false;
    let textStarted = false;
    const toolOutputs = new Set<string>();

    try {
      let result;
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          result = next.value;
          break;
        }
        renderEvent(next.value, {
          screen,
          redraw,
          toolOutputs,
          onStepStart: () => {
            reasoningShown = false;
            textStarted = false;
          },
          onReasoning: () => {
            if (reasoningShown) return;
            screen.pushKind('reasoning', '思考中…');
            reasoningShown = true;
          },
          onText: (text) => {
            if (!textStarted) {
              screen.pushLine('');
              textStarted = true;
            }
            screen.appendToLast(text);
          },
          onUsage: (inputTokens, outputTokens) => {
            runTokensIn += inputTokens;
            runTokensOut += outputTokens;
          },
          onCost: (costCny) => {
            runCost = costCny;
          },
        });
      }

      messages = result.messages;
      runTokensIn = result.usage.inputTokens;
      runTokensOut = result.usage.outputTokens;
      cumulativeCost += result.costCny;
      runCost = 0;
      cfg.store.saveMessages(taskId, result.messages);
      cfg.store.saveTrace(taskId, result.trace);
      cfg.store.updateTask(taskId, {
        status: result.error ? (result.stopReason === 'aborted' ? 'aborted' : 'failed') : 'completed',
        costCny: result.costCny,
        steps: result.steps,
        stopReason: result.stopReason,
      });
      recordUsage(cfg, taskId, turnTarget, result);

      if (result.stopReason === 'aborted') screen.pushKind('warn', '已中断');
      else if (result.error) screen.pushKind('error', result.error.userMessage);
    } catch (error) {
      screen.pushKind('error', `运行失败：${error instanceof Error ? error.message : String(error)}`);
      cfg.store.updateTask(taskId, { status: 'failed', stopReason: 'error' });
    } finally {
      runCost = 0;
      runStartedAt = 0;
      clearRetryTimer();
      clearTickTimer();
      if (activeController === controller) activeController = undefined;
      redraw();
    }
  };

  const submit = (value: string) => {
    const command = value.trim();
    if (!command) return;
    if (command.startsWith('/')) {
      handleCommand(command);
      redraw();
      return;
    }
    activeRun = runTurn(value).finally(() => {
      activeRun = undefined;
    });
  };

  const handleCommand = (command: string) => {
    const [name, ...args] = command.split(/\s+/);
    switch (name) {
      case '/exit':
        requestExit();
        break;
      case '/clear':
        screen.clear();
        break;
      case '/model': {
        const spec = args.join(' ');
        if (!spec) {
          openModelPicker();
          break;
        }
        const next = parseModel(spec, { defaultProvider: target.providerId, defaultModel: target.modelId });
        if (!next || !cfg.getProviderRecord(next.providerId)) {
          screen.pushKind('error', `模型无效或服务商未配置：${spec}`);
          break;
        }
        target = next;
        screen.pushKind('ok', `已切换模型：${target.providerId}/${target.modelId}`);
        break;
      }
      case '/cost':
        screen.pushLine(`本次 token：输入 ${runTokensIn} / 输出 ${runTokensOut}；累计花费：${formatMoney(cumulativeCost)}`);
        break;
      case '/help':
        screen.pushKind('muted', '/exit 退出 · /clear 清屏 · /model 选择/切换模型 · /cost 查看费用 · /help 帮助');
        screen.pushKind('muted', 'Ctrl/Alt+←→ 按词跳转 · Ctrl+W 删词 · PageUp/PageDown 翻看历史输出 · End 回到底部 · Ctrl+L 清屏');
        break;
      default:
        screen.pushKind('warn', `未知命令：${name}。输入 /help 查看可用命令。`);
    }
  };

  /** 打开模型选择器：列出所有「已启用且有密钥」的服务商的全部模型。 */
  const openModelPicker = () => {
    const client = cfg.client({ modelId: target.modelId });
    const options: { providerId: string; modelId: string }[] = [];
    for (const record of cfg.listProviders()) {
      if (!record.enabled) continue;
      if (!client.getProvider(record.id)) continue; // 无密钥的列出来也切不过去
      for (const model of cfg.modelsFor(record.id)) {
        options.push({ providerId: record.id, modelId: model.id });
      }
    }
    if (options.length === 0) {
      screen.pushKind('error', '没有可切换的模型。运行 cf provider add <id> 先配置。');
      return;
    }
    pickerOptions = options;
    pickerIndex = Math.max(
      0,
      options.findIndex((o) => o.providerId === target.providerId && o.modelId === target.modelId),
    );
    pickerOpen = true;
    syncPicker();
  };

  const closeModelPicker = () => {
    pickerOpen = false;
    screen.setPicker(undefined);
  };

  const syncPicker = () => {
    const items = pickerOptions.map((o) => {
      const current = o.providerId === target.providerId && o.modelId === target.modelId;
      return `${o.providerId}/${o.modelId}${current ? '  ✓ 当前' : ''}`;
    });
    screen.setPicker({ title: '选择模型', items, index: pickerIndex });
  };

  /** 选择器打开期间接管所有按键。返回后由调用方统一重绘。 */
  const handlePickerKey = (key: string) => {
    const last = pickerOptions.length - 1;
    switch (key) {
      case 'up':
        pickerIndex = Math.max(0, pickerIndex - 1);
        break;
      case 'down':
        pickerIndex = Math.min(last, pickerIndex + 1);
        break;
      case 'home':
        pickerIndex = 0;
        break;
      case 'end':
        pickerIndex = last;
        break;
      case 'pageup':
        pickerIndex = Math.max(0, pickerIndex - 8);
        break;
      case 'pagedown':
        pickerIndex = Math.min(last, pickerIndex + 8);
        break;
      case 'enter': {
        const option = pickerOptions[pickerIndex];
        closeModelPicker();
        if (!option) return;
        target = option;
        screen.pushKind('ok', `已切换模型：${target.providerId}/${target.modelId}`);
        break;
      }
      case 'escape':
      case 'ctrl-c':
        closeModelPicker();
        break;
      default:
        break; // 其余按键在选择器打开时一律忽略
    }
    if (pickerOpen) syncPicker();
  };

  const handleCtrlC = () => {
    const now = Date.now();
    if (now - lastCtrlCAt <= DOUBLE_CTRL_C_MS) {
      requestExit();
      return;
    }
    lastCtrlCAt = now;
    if (activeController) {
      activeController.abort();
      screen.pushKind('warn', '正在中断，短时间内再次按 Ctrl+C 可退出');
    } else {
      screen.pushKind('muted', '再次按 Ctrl+C 退出');
    }
    redraw();
  };

  function onData(data: Buffer): void {
    pendingInput = Buffer.concat([pendingInput, data]);
    while (pendingInput.length > 0) {
      if (pasteMode) {
        const endIndex = pendingInput.indexOf(PASTE_END);
        if (endIndex === -1) return;
        input.insert(pendingInput.subarray(0, endIndex).toString('utf8'));
        pendingInput = pendingInput.subarray(endIndex + PASTE_END.length);
        pasteMode = false;
        redraw();
        continue;
      }

      const decoded = decodeKey(pendingInput);
      if (decoded.consumed === 0) return;
      pendingInput = pendingInput.subarray(decoded.consumed);
      if (drawer.open) {
        // 抽屉打开期间接管全部按键；机制与模型选择器一致
        const result = drawer.handleKey(decoded.key);
        if (result.type === 'answer') {
          settlePermission(result.answer);
        } else if (result.type === 'ask_reason') {
          screen.setOverlay(undefined);
          reasonMode = true;
          input.clear();
          screen.setInputPrompt(`${paint(FG.yellow, '原因：')} `);
        } else {
          screen.setOverlay(drawer.render(term.size().cols));
        }
        redraw();
        continue;
      }
      if (pickerOpen) {
        // 选择器打开期间接管一切按键（含 ctrl-c：关选择器而不是退出）
        handlePickerKey(decoded.key);
        redraw();
        continue;
      }
      const hintsActive = !hintsHidden && input.value.startsWith('/') && !input.value.includes('\n') && hintMatches().length > 0;
      if (hintsActive && decoded.key === 'tab') {
        const matches = hintMatches();
        const pick = matches[hintIndex] ?? matches[0]!;
        input.clear();
        input.insert(pick.takesArg ? `${pick.name} ` : pick.name);
      } else if (hintsActive && decoded.key === 'up') {
        hintIndex = Math.max(0, hintIndex - 1);
      } else if (hintsActive && decoded.key === 'down') {
        hintIndex = Math.min(hintMatches().length - 1, hintIndex + 1);
      } else if (hintsActive && decoded.key === 'escape') {
        hintsHidden = true;
      } else if (decoded.key === 'paste-start') {
        pasteMode = true;
      } else if (decoded.key === 'ctrl-c') {
        // 抽屉/原因输入挂着时先结算成拒绝，避免 Promise 悬着，再走中断逻辑
        if (drawer.open) {
          drawer.close();
          settlePermission({ decision: 'deny' });
        }
        if (reasonMode) {
          reasonMode = false;
          settlePermission({ decision: 'deny' });
        }
        handleCtrlC();
      } else if (decoded.key === 'ctrl-d') {
        if (!input.value) requestExit();
        else input.deleteForward();
      } else if (decoded.key === 'enter') {
        if (reasonMode) {
          reasonMode = false;
          settlePermission({ decision: 'deny', reason: input.commit() });
        } else if (activeController) {
          screen.pushKind('warn', '当前任务仍在运行，可按 Ctrl+C 中断');
        } else {
          submit(input.commit());
        }
      } else if (reasonMode && decoded.key === 'escape') {
        reasonMode = false;
        settlePermission({ decision: 'deny' });
      } else if (decoded.key === 'pageup' || decoded.key === 'pagedown') {
        const page = Math.max(3, term.size().rows - 4);
        screen.scrollBy(decoded.key === 'pageup' ? page : -page);
      } else if (decoded.key === 'end') {
        screen.resetScroll();
      } else if (decoded.key === 'clear-screen') {
        screen.clear();
      } else {
        const before = input.value;
        input.handleKey(decoded.key);
        if (input.value !== before) {
          hintsHidden = false; // 输入变化后重新弹出提示
          const matches = hintMatches();
          if (hintIndex > matches.length - 1) hintIndex = 0;
        }
      }
      redraw();
    }
  }

  const removeResize = term.onResize((size) => {
    screen.resize(size);
    if (drawer.open) screen.setOverlay(drawer.render(size.cols));
    redraw();
  });
  const mcpConfigs = mergeMcpConfigs(cfg.listMcpServers(), loadProjectMcp(workingDir));
  const mcp = await loadMcpTools(mcpConfigs);
  let signalCleanupStarted = false;
  const cleanupForSignal = (code: number) => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    exiting = true;
    activeController?.abort();
    detachInput();
    restoreTerminal();
    void Promise.all(mcp.clients.map((client) => client.close().catch(() => {}))).finally(() => {
      try {
        cfg.close();
      } finally {
        process.exit(code);
      }
    });
  };
  const onSigint = () => cleanupForSignal(130);
  const onSigterm = () => cleanupForSignal(143);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    term.enterAltScreen();
    altScreenEntered = true;
    term.enterRawMode();
    rawModeEntered = true;
    term.hideCursor();
    for (const tool of mcp.tools) tools.register(tool);
    for (const line of renderBanner(
      {
        version: VERSION,
        model: `${target.providerId}/${target.modelId}`,
        modelCount: countSwitchableModels(),
        mode: profile.mode,
        cwd: workingDir.replace(homedir(), '~'),
        sandbox: sandboxKind,
        firstRun: !hasUsableProvider,
        secretBackend: secretBackendLabel(),
      },
      term.size().cols,
    )) {
      screen.pushRaw(line);
    }
    for (const failure of mcp.failures) {
      screen.pushKind('warn', `MCP 服务器 ${failure.name} 启动失败：${failure.error.userMessage}`);
    }
    attachInput();
    redraw();
    await exitRequested;
    if (activeRun) await activeRun;
    return exitCode;
  } finally {
    detachInput();
    removeResize();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await Promise.all(mcp.clients.map((client) => client.close().catch(() => {})));
    restoreTerminal();
  }
}

interface EventRenderContext {
  screen: Screen;
  redraw: () => void;
  toolOutputs: Set<string>;
  onStepStart: () => void;
  onReasoning: () => void;
  onText: (text: string) => void;
  onUsage: (inputTokens: number, outputTokens: number) => void;
  onCost: (costCny: number) => void;
}

function renderEvent(event: AgentEvent, context: EventRenderContext): void {
  switch (event.type) {
    case 'step_start':
      context.onStepStart();
      if (event.step > 1) context.screen.pushKind('muted', `── 第 ${event.step} 步 ──`);
      break;
    case 'model_stream':
      if (event.event.type === 'reasoning_delta') context.onReasoning();
      else if (event.event.type === 'text_delta') context.onText(event.event.text);
      else if (event.event.type === 'usage') {
        context.onUsage(event.event.usage.inputTokens, event.event.usage.outputTokens);
      }
      break;
    case 'tool_start':
      context.screen.pushKind('tool-call', `${event.name} ${oneLine(event.args)}`);
      break;
    case 'tool_output':
      if (!context.toolOutputs.has(event.callId)) {
        context.screen.pushKind('tool-out', '');
        context.toolOutputs.add(event.callId);
      }
      context.screen.appendToLast(event.chunk, 'tool-out');
      break;
    case 'tool_end':
      context.screen.pushKind(event.ok ? 'ok' : 'error', event.summary, `(${event.durationMs}ms)`);
      break;
    case 'file_changed':
      context.screen.pushKind('file-changed', `${event.op} ${event.path}`);
      if (event.diff) context.screen.pushDiff(event.diff);
      break;
    case 'compaction':
      context.screen.pushKind('reasoning', `上下文已压缩（折叠 ${event.removedMessages} 条消息）`);
      break;
    case 'notice':
      context.screen.pushKind(event.level === 'warn' ? 'warn' : 'muted', event.message);
      break;
    case 'permission_resolved':
      context.screen.pushKind(
        event.allowed ? 'ok' : 'error',
        event.allowed ? '已授权工具操作' : `已拒绝工具操作${event.reason ? `：${event.reason}` : ''}`,
      );
      break;
    case 'permission_request':
    case 'checkpoint':
    case 'task_end':
      break;
    case 'cost':
      context.onCost(event.taskTotalCny);
      break;
  }
  context.redraw();
}

function oneLine(value: Record<string, unknown>): string {
  const json = JSON.stringify(value);
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}

function formatMoney(costCny: number): string {
  if (costCny === 0) return '¥0';
  if (costCny < 0.01) return `¥${costCny.toFixed(5)}`;
  return `¥${costCny.toFixed(4)}`;
}
