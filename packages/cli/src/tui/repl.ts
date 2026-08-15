import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  AgentRunner,
  PermissionEngine,
  ToolRegistry,
  loadMcpTools,
  type AgentEvent,
  type AgentRunOptions,
  type Message,
  type PermissionAnswer,
  type PermissionRequest,
} from '@confluence/core';
import type { AppConfig } from '../config.js';
import { confirm, err, prompt } from '../ui.js';
import {
  buildProfile,
  loadProjectMcp,
  mergeMcpConfigs,
  parseModel,
  recordUsage,
  systemPrompt,
} from '../commands/run.js';
import { decodeKey, InputBuffer } from './input.js';
import { Screen, type StatusBar } from './screen.js';
import { Term } from './term.js';

const DOUBLE_CTRL_C_MS = 1_200;
const PASTE_END = Buffer.from('\u001b[201~');

export async function replCommand(cfg: AppConfig): Promise<number> {
  const initialTarget = parseModel(undefined, cfg.settings());
  if (!initialTarget) {
    err('未指定模型，且没有默认模型。运行 cf provider add <id> 先配置一个。');
    return 1;
  }
  if (!cfg.getProviderRecord(initialTarget.providerId)) {
    err(`未配置服务商 ${initialTarget.providerId}。运行 cf provider add ${initialTarget.providerId}`);
    return 1;
  }

  const term = new Term();
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
  let resolveExit: (() => void) | undefined;
  const exitRequested = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise;
  });

  const status = (): StatusBar => ({
    model: `${target.providerId}/${target.modelId}`,
    tokensIn: runTokensIn,
    tokensOut: runTokensOut,
    costCny: cumulativeCost + runCost,
    mode: profile.mode,
    running: activeController !== undefined,
  });

  const redraw = () => {
    screen.setStatus(status());
    term.hideCursor();
    term.write(screen.render(input.value, input.cursorOffset));
    term.showCursor();
  };

  const requestExit = (code = 0) => {
    if (exiting) return;
    exiting = true;
    exitCode = code;
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

  const permissionResolver = async (request: PermissionRequest): Promise<PermissionAnswer> => {
    detachInput();
    term.exitRawMode();
    rawModeEntered = false;
    term.showCursor();
    term.write('\u001b[H\u001b[J');
    let answer: string;
    try {
      answer = await confirm(`需要确认（风险：${request.risk}）\n${request.summary}\n${request.affects.map((item) => `  ${item}`).join('\n')}\n如何处理？`, [
        { key: 'y', label: '允许这一次' },
        { key: 'a', label: '本次会话内始终允许同类操作' },
        { key: 'n', label: '拒绝' },
        { key: 'r', label: '拒绝并说明原因' },
      ]);
      if (answer === 'y') return { decision: 'allow' };
      if (answer === 'a') return { decision: 'allow_always' };
      if (answer === 'n') return { decision: 'deny' };
      const reason = await prompt('原因：');
      return { decision: 'deny', reason };
    } finally {
      if (!exiting) {
        term.enterRawMode();
        rawModeEntered = true;
        attachInput();
        redraw();
      }
    }
  };

  const runTurn = async (goal: string): Promise<void> => {
    const taskId = `task_${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    activeController = controller;
    runTokensIn = 0;
    runTokensOut = 0;
    runCost = 0;
    screen.pushLine(`❯ ${goal}`);
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
        screen.pushLine(`! ${message}`);
        redraw();
      },
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
            screen.pushMutedLine('[思考…]');
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

      if (result.stopReason === 'aborted') screen.pushLine('! 已中断');
      else if (result.error) screen.pushLine(`✗ ${result.error.userMessage}`);
    } catch (error) {
      screen.pushLine(`✗ 运行失败：${error instanceof Error ? error.message : String(error)}`);
      cfg.store.updateTask(taskId, { status: 'failed', stopReason: 'error' });
    } finally {
      runCost = 0;
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
          screen.pushLine(`当前模型：${target.providerId}/${target.modelId}`);
          break;
        }
        const next = parseModel(spec, { defaultProvider: target.providerId, defaultModel: target.modelId });
        if (!next || !cfg.getProviderRecord(next.providerId)) {
          screen.pushLine(`✗ 模型无效或服务商未配置：${spec}`);
          break;
        }
        target = next;
        screen.pushLine(`✓ 已切换模型：${target.providerId}/${target.modelId}`);
        break;
      }
      case '/cost':
        screen.pushLine(`本次 token：输入 ${runTokensIn} / 输出 ${runTokensOut}；累计花费：${formatMoney(cumulativeCost)}`);
        break;
      case '/help':
        screen.pushLine('/exit 退出 · /clear 清屏 · /model <id> 切换模型 · /cost 查看费用 · /help 帮助');
        break;
      default:
        screen.pushLine(`未知命令：${name}。输入 /help 查看可用命令。`);
    }
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
      screen.pushLine('! 正在中断，短时间内再次按 Ctrl+C 可退出');
    } else {
      screen.pushLine('再次按 Ctrl+C 退出');
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
      if (decoded.key === 'paste-start') {
        pasteMode = true;
      } else if (decoded.key === 'ctrl-c') {
        handleCtrlC();
      } else if (decoded.key === 'ctrl-d') {
        if (!input.value) requestExit();
        else input.deleteForward();
      } else if (decoded.key === 'enter') {
        if (activeController) {
          screen.pushLine('! 当前任务仍在运行，可按 Ctrl+C 中断');
        } else {
          submit(input.commit());
        }
      } else {
        input.handleKey(decoded.key);
      }
      redraw();
    }
  }

  const removeResize = term.onResize((size) => {
    screen.resize(size);
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
    screen.pushLine('Confluence TUI · Agent 模式');
    screen.pushLine('输入任务并回车，输入 /help 查看命令，双击 Ctrl+C 退出。');
    for (const failure of mcp.failures) screen.pushLine(`! MCP 服务器 ${failure.name} 启动失败：${failure.error.userMessage}`);
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
      if (event.step > 1) context.screen.pushLine(`── 第 ${event.step} 步 ──`);
      break;
    case 'model_stream':
      if (event.event.type === 'reasoning_delta') context.onReasoning();
      else if (event.event.type === 'text_delta') context.onText(event.event.text);
      else if (event.event.type === 'usage') {
        context.onUsage(event.event.usage.inputTokens, event.event.usage.outputTokens);
      }
      break;
    case 'tool_start':
      context.screen.pushLine(`▸ ${event.name} ${oneLine(event.args)}`);
      break;
    case 'tool_output':
      if (!context.toolOutputs.has(event.callId)) {
        context.screen.pushLine('');
        context.toolOutputs.add(event.callId);
      }
      context.screen.appendToLast(event.chunk);
      break;
    case 'tool_end':
      context.screen.pushLine(`${event.ok ? '✓' : '✗'} ${event.summary} (${event.durationMs}ms)`);
      break;
    case 'file_changed':
      context.screen.pushLine(`  ${event.op} ${event.path}`);
      break;
    case 'compaction':
      context.screen.pushLine(`! 上下文已压缩（折叠 ${event.removedMessages} 条消息）`);
      break;
    case 'notice':
      context.screen.pushLine(`${event.level === 'warn' ? '!' : '·'} ${event.message}`);
      break;
    case 'permission_resolved':
      context.screen.pushLine(event.allowed ? '✓ 已授权工具操作' : `✗ 已拒绝工具操作${event.reason ? `：${event.reason}` : ''}`);
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
