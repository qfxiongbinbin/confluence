# 接入说明

四个文件放进 `packages/cli/src/tui/`：

```
theme.ts       ANSI 色号 + 行类型→装订线映射 + 显示宽度工具
banner.ts      启动横幅（完整 / 单行 / 首启三态）
confirm.ts     权限确认抽屉
statusbar.ts   分段状态栏
```

零新增依赖，只用 `@confluence/core` 已导出的 `PermissionRequest` / `PermissionAnswer`。

---

## 1. screen.ts

**删掉重复实现**：`stringWidth` / `charWidth` / `truncateToWidth` / `unitsOf` 现在在 `theme.ts`，改为

```ts
import { LINE_STYLES, GUTTER_WIDTH, renderLine, stringWidth, truncateToWidth, type LineKind } from './theme.js';
```

`screen.ts` 里原来 `export function stringWidth` 有测试引用（`test/screen.test.js`），保留一行再导出即可：

```ts
export { stringWidth } from './theme.js';
```

**LineKind 扩展**：原来只有 `normal | muted | diff-add | diff-del | diff-meta`，换成 `theme.ts` 的 14 种。对应新增推送方法：

```ts
pushKind(kind: LineKind, text: string, meta?: string): void {
  this.push(clean(text).split('\n').map((line) => ({ text: line, kind })));
}
```

`colorize()` 改成调用 `renderLine(line.kind, line.text)` —— 装订线由 kind 决定，调用方不再自己拼 `▸` `✓` 前缀。

**软换行要留出装订线**：`wrapLine(line, cols)` 的可用宽度改为 `cols - GUTTER_WIDTH`，续行前面补 `CONTINUATION`。否则长行折回来会顶到第 1 列，和装订线混在一起。

**浮层通道**：`picker` / `hints` 之外加一个通用出口，抽屉复用同一套让位逻辑：

```ts
private overlay?: string[];
setOverlay(lines: string[] | undefined): void { this.overlay = lines; }
```

`render()` 里 `overlayLines` 的取值顺序：`overlay ?? picker ?? hints`（抽屉优先级最高，打开时不显示命令提示）。

**状态栏**：`statusText()` 换成 `renderStatusBar(this.status, this.terminalSize.cols)`，`StatusBar` 接口改从 `statusbar.ts` 导入（多了 `elapsedSec` / `scrolled` 两个可选字段）。

---

## 2. repl.ts

**开屏**：`screen.pushLine('Confluence TUI · Agent 模式')` 那两行换成

```ts
for (const line of renderBanner({
  version: VERSION,
  model: `${target.providerId}/${target.modelId}`,
  modelCount: countSwitchableModels(cfg),
  mode: profile.mode,
  cwd: workingDir.replace(homedir(), '~'),
  sandbox: sandboxKind,          // 不可用时传 undefined
  firstRun: !hasUsableProvider,
  secretBackend: cfg.secretBackend(),
}, term.size().cols)) screen.pushLine(line);
```

窄于 60 列自动降级成单行，不用调用方判断。

**权限确认**：`permissionResolver` 整个换掉 —— 不再 `detachInput()` / `exitRawMode()` / 清屏。

```ts
const drawer = new ConfirmDrawer();
let pendingPermission: ((answer: PermissionAnswer) => void) | undefined;
let reasonMode = false;

const permissionResolver = (request: PermissionRequest) =>
  new Promise<PermissionAnswer>((resolve) => {
    pendingPermission = resolve;
    drawer.show(request, request.affects.length > 3);
    screen.setOverlay(drawer.render(term.size().cols));
    redraw();
  });
```

`onData` 的按键分发里，**在 picker 之前**插入抽屉分支：

```ts
if (drawer.open) {
  const result = drawer.handleKey(decoded.key);
  if (result.type === 'answer') {
    screen.setOverlay(undefined);
    pendingPermission?.(result.answer);
    pendingPermission = undefined;
  } else if (result.type === 'ask_reason') {
    screen.setOverlay(undefined);
    reasonMode = true;               // 输入行提示语转为「原因：」
  } else {
    screen.setOverlay(drawer.render(term.size().cols));
  }
  redraw();
  continue;
}
```

`reasonMode` 下回车提交：`pendingPermission?.({ decision: 'deny', reason: input.commit() })`，然后 `reasonMode = false`。

`^C`：抽屉打开时先 `drawer.close()` + `pendingPermission?.({ decision: 'deny' })` 再走原来的中断逻辑，避免 Promise 悬着。

`onResize` 里如果 `drawer.open` 要重算 `screen.setOverlay(drawer.render(size.cols))`。

**renderEvent 换 kind**：原来手拼符号的地方改成

| 事件 | 现在 | 改为 |
|---|---|---|
| `tool_start` | `pushLine('▸ …')` | `pushKind('tool-call', …)` |
| `tool_output` | `appendToLast` | `pushKind('tool-out', …)` |
| `tool_end` | `'✓'/'✗' + summary` | `pushKind(event.ok ? 'ok' : 'error', event.summary, `(${event.durationMs}ms)`)` |
| `file_changed` | `pushMutedLine('  ✎ …')` | `pushKind('file-changed', `${event.op} ${event.path}`)` |
| `notice` | `'!'/'·' + message` | `pushKind(event.level === 'warn' ? 'warn' : 'muted', event.message)` |
| `compaction` | `'! 上下文已压缩…'` | `pushKind('reasoning', …)` |
| 用户提交 | `pushLine('❯ ' + goal)` | `pushKind('user', goal)` |
| 模型思考 | `pushMutedLine('[思考…]')` | `pushKind('reasoning', '思考中…')` |

**限流退避**：`client` 的重试回调目前只落一条 warn，补一个倒计时（每秒 redraw 一次）：

```ts
pushKind('warn', `限流 ${status} · ${providerId} ${hint}`);
pushKind('muted', `第 ${attempt} 次重试，${remain}s 后继续  ^C 放弃`);
```

第二行用 `appendToLast` 原地更新，不要每秒新增一行。

---

## 3. NO_COLOR

`theme.ts` 的 `setColorEnabled(stdout.isTTY && !process.env['NO_COLOR'])` 在 `repl.ts` 启动时调一次。关掉颜色后装订线符号仍在，各类内容照样可辨 —— 这是符号先行、颜色其次的原因。

## 4. 测试

`test/screen.test.js` 现有断言里含硬编码的 `\u001b[32m` 等前缀，改成从 `theme.js` 取常量。新增建议：

- `renderLine('ok', 'x')` 在 `setColorEnabled(false)` 下等于 `'✓ x'`
- `ConfirmDrawer.handleKey('3')` 返回 `{ decision: 'deny' }`，且 `open === false`
- `renderBanner(info, 40)` 只返回 1 行
- 抽屉渲染行数 ≤ 输出区高度的一半（窄终端不把输出挤没）
