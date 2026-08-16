import type { TermSize } from './term.js';
import {
  BOLD,
  CONTINUATION,
  FG,
  GUTTER_WIDTH,
  LINE_STYLES,
  RESET,
  charWidth,
  paint,
  renderLine,
  stringWidth,
  truncateToWidth,
  unitsOf,
  type LineKind,
} from './theme.js';
import { renderStatusBar, type StatusBar } from './statusbar.js';

export type { StatusBar } from './statusbar.js';
export { stringWidth } from './theme.js';

interface OutputLine {
  text: string;
  kind: LineKind;
  /** 软换行的续行：不重复装订线符号，只保留缩进。 */
  continuation?: boolean;
  /** 已渲染完毕的行（横幅等）：跳过 clean 与装订线，原样显示。 */
  raw?: boolean;
  /** 右侧灰色尾注（如耗时），渲染时拼接。 */
  meta?: string;
}

export interface PickerState {
  title: string;
  items: string[];
  index: number;
}

export interface HintState {
  items: string[];
  index: number;
}

const MAX_OUTPUT_LINES = 2_000;
const GRAY = FG.gray;
const CYAN = FG.cyan;

export class Screen {
  private terminalSize: TermSize;
  private readonly output: OutputLine[] = [];
  private status: StatusBar = {
    model: '-',
    tokensIn: 0,
    tokensOut: 0,
    costCny: 0,
    mode: 'agent',
    running: false,
  };
  /** 输出区向上滚动的显示行数；0 表示贴底显示最新内容 */
  private scrollOffset = 0;
  /** 交互选择器（如模型切换）。undefined 表示未打开。 */
  private picker?: PickerState;
  /** 命令提示（输入以 / 开头时出现）。undefined 表示未显示。 */
  private hints?: HintState;
  /** 通用浮层（权限确认抽屉等）。优先级高于 picker / hints。 */
  private overlay?: string[];
  /** 输入行提示语；reasonMode 等场景会换掉默认的「> 」。 */
  private inputPrompt: string;

  constructor(size: TermSize) {
    this.terminalSize = size;
    this.inputPrompt = `${paint(CYAN, '>')} `;
  }

  setPicker(picker: PickerState | undefined): void {
    this.picker = picker;
  }

  setHints(hints: HintState | undefined): void {
    this.hints = hints;
  }

  setOverlay(lines: string[] | undefined): void {
    this.overlay = lines;
  }

  setInputPrompt(prompt: string): void {
    this.inputPrompt = prompt;
  }

  resize(size: TermSize): void {
    this.terminalSize = size;
  }

  pushLine(text: string): void {
    this.push(clean(text).split('\n').map((line) => ({ text: line, kind: 'normal' as const })));
  }

  pushMutedLine(text: string): void {
    this.push([{ text: clean(text), kind: 'muted' }]);
  }

  /** 按行类型推送：装订线符号与配色由 theme 决定，调用方不再手拼前缀。 */
  pushKind(kind: LineKind, text: string, meta?: string): void {
    const parts = clean(text).split('\n');
    this.push(
      parts.map((text, index) => ({
        text,
        kind,
        ...(index === parts.length - 1 && meta ? { meta } : {}),
      })),
    );
  }

  /** 推入已渲染好的行（横幅等）：跳过 clean 与装订线，保留原有 ANSI。 */
  pushRaw(text: string): void {
    this.output.push(...text.split('\n').map((line) => ({ text: line, kind: 'normal' as const, raw: true })));
    this.trimOutput();
  }

  /** 渲染引擎产出的 unified diff：+绿 -红、文件头青色加粗。 */
  pushDiff(diff: string): void {
    const lines = clean(diff)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line): OutputLine => {
        if (line.startsWith('--- ') || line.startsWith('+++ ')) return { text: line, kind: 'diff-meta' };
        if (line.startsWith('+')) return { text: line, kind: 'diff-add' };
        if (line.startsWith('-')) return { text: line, kind: 'diff-del' };
        return { text: line, kind: 'muted' };
      });
    this.push(lines);
  }

  appendToLast(text: string, kind: LineKind = 'normal'): void {
    const parts = clean(text).split('\n');
    const last = this.output[this.output.length - 1];
    if (!last || last.kind !== kind || last.raw) {
      this.output.push({ text: '', kind });
    }
    this.output[this.output.length - 1]!.text += parts[0]!;
    if (parts.length > 1) {
      this.push(parts.slice(1).map((line) => ({ text: line, kind })));
      return;
    }
    this.trimOutput();
  }

  /** 原地替换最后一行（限流倒计时等每秒刷新的行，不新增行数）。 */
  replaceLast(text: string, kind: LineKind = 'muted'): void {
    const last = this.output[this.output.length - 1];
    if (!last) {
      this.push([{ text: clean(text), kind }]);
      return;
    }
    last.text = clean(text);
    last.kind = kind;
    last.meta = undefined;
    last.continuation = false;
    last.raw = false;
  }

  clear(): void {
    this.output.length = 0;
    this.scrollOffset = 0;
  }

  /**
   * 在输出区向上（正数）/向下（负数）滚动。向上最多滚到最早内容，
   * 向下最多回到贴底。返回是否仍处于滚动状态。
   */
  scrollBy(displayLines: number): boolean {
    const max = this.maxScroll();
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + displayLines, max));
    return this.scrollOffset > 0;
  }

  resetScroll(): void {
    this.scrollOffset = 0;
  }

  setStatus(status: StatusBar): void {
    this.status = { ...status };
  }

  render(input: string, cursorOffset: number): string {
    // —— 输入区：按码点软换行，避免长行触发终端自动折行把整个布局顶掉 ——
    const inputRows = this.wrapInputTail(input, cursorOffset);
    let outputRows = Math.max(0, this.terminalSize.rows - inputRows.rows.length - 2);

    // —— 浮层：抽屉 > 选择器 > 命令提示，占输出区底部若干行 ——
    const overlayLines: string[] = [];
    if (this.overlay) {
      // 抽屉行数封顶为输出区一半：窄终端下也不把已有输出完全挤没
      const cap = Math.max(3, Math.floor(outputRows / 2));
      overlayLines.push(...this.overlay.slice(-cap));
    } else if (this.picker) {
      const maxItems = Math.max(0, outputRows - 1);
      const from = Math.max(0, Math.min(this.picker.index - Math.floor(maxItems / 2), this.picker.items.length - maxItems));
      const visible = this.picker.items.slice(from, from + maxItems);
      overlayLines.push(`${GRAY}${this.picker.title}（↑↓ 移动 · Enter 确认 · Esc 取消）${RESET}`);
      visible.forEach((item, i) => {
        const label = truncateToWidth(item, Math.max(4, this.terminalSize.cols - 4));
        const selected = from + i === this.picker!.index;
        overlayLines.push(selected ? `${CYAN}❯ ${label}${RESET}` : `  ${GRAY}${label}${RESET}`);
      });
    } else if (this.hints && this.hints.items.length > 0) {
      // 命令提示不抢焦点：输入照常编辑，仅在输入框上方列出匹配项
      const maxItems = Math.max(0, outputRows - 1);
      const from = Math.max(0, Math.min(this.hints.index, this.hints.items.length - maxItems));
      const visible = this.hints.items.slice(from, from + maxItems);
      overlayLines.push(`${GRAY}命令（Tab 补全 · ↑↓ 选择 · Enter 执行 · Esc 隐藏）${RESET}`);
      visible.forEach((item, i) => {
        const sep = item.indexOf(' — ');
        const cmd = sep === -1 ? item : item.slice(0, sep);
        const desc = sep === -1 ? '' : item.slice(sep + 3);
        const cmdLabel = truncateToWidth(cmd, Math.max(4, this.terminalSize.cols - 4));
        const descLabel = truncateToWidth(desc, Math.max(0, this.terminalSize.cols - 4 - stringWidth(cmd)));
        const selected = from + i === this.hints!.index;
        overlayLines.push(
          selected
            ? `${CYAN}❯ ${cmdLabel}${RESET} ${GRAY}${descLabel}${RESET}`
            : `  ${cmdLabel} ${GRAY}${descLabel}${RESET}`,
        );
      });
    }
    if (overlayLines.length > 0) outputRows = Math.max(0, outputRows - overlayLines.length);

    const wrapped = wrapTail(this.output, outputRows + this.scrollOffset, this.terminalSize.cols);
    const end = Math.max(0, wrapped.length - this.scrollOffset);
    const start = Math.max(0, end - outputRows);
    const rows: string[] = wrapped.slice(start, end).map(colorize);
    while (rows.length < outputRows) rows.push('');
    rows.push(...overlayLines);

    // 每行末尾擦到行尾（EL）：外界往终端写的东西（stderr 警告、进度条…）
    // 以及上一次更长的行，都会在下一次重绘时被彻底清掉，不会叠在输入区后面。
    rows.push(`${GRAY}${'─'.repeat(Math.max(1, this.terminalSize.cols))}${RESET}`);
    const promptWidth = stringWidth(this.inputPrompt);
    const promptPad = ' '.repeat(promptWidth);
    inputRows.rows.forEach((line, index) => rows.push(`${index === 0 ? this.inputPrompt : promptPad}${line}`));
    rows.push(
      renderStatusBar(
        { ...this.status, ...(this.scrollOffset > 0 ? { scrolled: this.scrollOffset } : {}) },
        this.terminalSize.cols,
      ),
    );
    const body = rows.map((row) => `${row}\u001b[K`).join('\n');

    const cursorRow = outputRows + 2 + inputRows.cursorRow;
    // 光标列必须按「显示宽度」算：中文等宽字符占 2 列，按码点数会导致光标左偏
    const cursorColumn = promptWidth + 1 + inputRows.cursorWidth;

    return `\u001b[H${body}\u001b[J\u001b[${cursorRow};${cursorColumn}H`;
  }

  /**
   * 把输入的尾部若干逻辑行软换行为显示行（每行预留提示语宽度），
   * 同时算出光标落在第几个显示行、行内第几列（显示宽度）。
   */
  private wrapInputTail(input: string, cursorOffset: number): { rows: string[]; cursorRow: number; cursorWidth: number } {
    const maxRows = Math.max(1, this.terminalSize.rows - 2);
    const width = Math.max(4, this.terminalSize.cols - 2);
    const lines = input.split('\n');

    // 光标的逻辑位置（行号 + 行内码点列号）
    const prefix = Array.from(input).slice(0, cursorOffset).join('');
    const cursorLogicalRow = prefix.split('\n').length - 1;
    const cursorLogicalCol = Array.from(prefix.split('\n').at(-1) ?? '').length;

    interface Seg {
      text: string;
      row: number;
    }
    const segments: Seg[] = [];
    let cursorSegIndex = -1;
    let cursorWidth = 0;
    lines.forEach((line, row) => {
      const units = Array.from(line);
      let current: string[] = [];
      let widthSoFar = 0;
      const pushSegment = () => segments.push({ text: current.join(''), row });
      units.forEach((unit, col) => {
        const unitWidth = charWidth(unit.codePointAt(0)!);
        if (widthSoFar + unitWidth > width) {
          pushSegment();
          current = [];
          widthSoFar = 0;
        }
        if (row === cursorLogicalRow && col === cursorLogicalCol && cursorSegIndex === -1) {
          cursorWidth = widthSoFar;
          cursorSegIndex = segments.length; // 正在累积的段将来落在这个下标
        }
        current.push(unit);
        widthSoFar += unitWidth;
      });
      // 行尾光标（col === units.length），或空行
      if (row === cursorLogicalRow && cursorLogicalCol >= units.length) {
        cursorWidth = widthSoFar;
        cursorSegIndex = segments.length; // 即将 push 的最后一段
      }
      pushSegment();
    });

    const visible = segments.slice(-maxRows);
    const firstIndex = segments.length - visible.length;
    // 光标所在显示行：不早于可见首行（输入向上截断时夹到可见区第一行）
    const cursorRow = cursorSegIndex === -1 ? 0 : Math.max(0, Math.min(cursorSegIndex - firstIndex, visible.length - 1));
    return { rows: visible.map((s) => s.text), cursorRow, cursorWidth };
  }

  /** 以软换行后的显示行为单位，输出区还能向上滚多少行 */
  private maxScroll(): number {
    const outputRows = Math.max(0, this.terminalSize.rows - 2);
    let displayLines = 0;
    for (let index = this.output.length - 1; index >= 0; index--) {
      displayLines += wrappedLineCount(this.output[index]!, this.terminalSize.cols);
      if (displayLines > outputRows + MAX_OUTPUT_LINES) break;
    }
    return Math.max(0, displayLines - outputRows);
  }

  private push(lines: OutputLine[]): void {
    this.output.push(...lines);
    this.trimOutput();
    this.scrollOffset = 0;
  }

  private trimOutput(): void {
    if (this.output.length > MAX_OUTPUT_LINES) this.output.splice(0, this.output.length - MAX_OUTPUT_LINES);
    this.scrollOffset = 0;
  }
}

function colorize(line: OutputLine): string {
  if (line.raw) return line.text;
  if (line.continuation) {
    const style = LINE_STYLES[line.kind];
    return `${CONTINUATION}${paint(style.textCodes, line.text)}`;
  }
  return renderLine(line.kind, line.text, line.meta);
}

/** 从存储行尾部向前软换行，累计拿到 enough 行即停，避免每帧折断全部 2000 行 */
function wrapTail(lines: OutputLine[], enough: number, cols: number): OutputLine[] {
  const wrapped: OutputLine[] = [];
  for (let index = lines.length - 1; index >= 0 && wrapped.length < enough; index--) {
    // 对话文本在换行前先做内联 Markdown → ANSI，避免标记被折行拆开
    const line = lines[index]!;
    const source = line.kind === 'normal' && !line.raw ? { ...line, text: mdToAnsi(line.text) } : line;
    wrapped.unshift(...wrapLine(source, cols));
  }
  return wrapped;
}

/**
 * 内联 Markdown → ANSI（零依赖，仅对话文本使用；diff 等代码内容不做转换）。
 * 支持加粗 / 斜体 / 删除线 / 行内代码。代码-span 先换占位符保护，避免内部
 * 的 * 或 _ 被误判为标记。
 */
export function mdToAnsi(text: string): string {
  if (!text.includes('*') && !text.includes('`') && !text.includes('~') && !text.includes('_')) return text;
  const codeSpans: string[] = [];
  let out = text.replace(/`([^`\n]+)`/g, (_, content: string) => {
    codeSpans.push(`${CYAN}${content}${RESET}`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  out = out
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, `${BOLD}$1${RESET}`)
    .replace(/(^|[\s（(【\[，。；：、！？「『])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=[\s，。；：、！？）)】\]」』]|$)/g, '$1\u001b[3m$2\u001b[0m')
    .replace(/(^|[\s（(【\[，。；：、！？「『])_(?=\S)([^_\n]+?)(?<=\S)_(?=[\s，。；：、！？）)】\]」』]|$)/g, '$1\u001b[3m$2\u001b[0m')
    .replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '\u001b[9m$1\u001b[0m');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codeSpans[Number(i)] ?? '');
}

function wrapLine(line: OutputLine, cols: number): OutputLine[] {
  // 正文可用宽度要扣掉装订线，续行再补 CONTINUATION 缩进，折回来不会顶到第 1 列
  const avail = cols - GUTTER_WIDTH;
  if (cols <= 0 || avail <= 0) return [line];
  const units = unitsOf(line.text);
  const segments: OutputLine[] = [];
  let current: string[] = [];
  let width = 0;
  let first = true;
  for (const unit of units) {
    if (width + unit.width > avail) {
      segments.push({ text: current.join(''), kind: line.kind, continuation: !first, raw: line.raw, meta: line.meta });
      current = [];
      width = 0;
      first = false;
    }
    current.push(unit.text);
    width += unit.width;
  }
  segments.push({ text: current.join(''), kind: line.kind, continuation: !first, raw: line.raw, meta: line.meta });
  return segments;
}

function wrappedLineCount(line: OutputLine, cols: number): number {
  const avail = cols - GUTTER_WIDTH;
  const width = stringWidth(line.text);
  if (cols <= 0 || avail <= 0 || width <= avail) return 1;
  return Math.ceil(width / avail);
}

function clean(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
