import type { TermSize } from './term.js';

export interface StatusBar {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costCny: number;
  mode: string;
  running: boolean;
}

const MAX_OUTPUT_LINES = 2_000;
const RESET = '\u001b[0m';
const GRAY = '\u001b[90m';
const CYAN = '\u001b[36m';

export class Screen {
  private terminalSize: TermSize;
  private readonly output: string[] = [];
  private status: StatusBar = {
    model: '-',
    tokensIn: 0,
    tokensOut: 0,
    costCny: 0,
    mode: 'agent',
    running: false,
  };

  constructor(size: TermSize) {
    this.terminalSize = size;
  }

  resize(size: TermSize): void {
    this.terminalSize = size;
  }

  pushLine(text: string): void {
    const lines = clean(text).split('\n');
    this.output.push(...lines);
    this.trimOutput();
  }

  pushMutedLine(text: string): void {
    this.output.push(`${GRAY}${clean(text)}${RESET}`);
    this.trimOutput();
  }

  appendToLast(text: string): void {
    const lines = clean(text).split('\n');
    if (this.output.length === 0) this.output.push('');
    this.output[this.output.length - 1] += lines[0]!;
    if (lines.length > 1) this.output.push(...lines.slice(1));
    if (this.output.length > MAX_OUTPUT_LINES) this.output.splice(0, this.output.length - MAX_OUTPUT_LINES);
  }

  clear(): void {
    this.output.length = 0;
  }

  setStatus(status: StatusBar): void {
    this.status = { ...status };
  }

  render(input: string, cursorCol: number): string {
    const inputLines = input.split('\n');
    const inputRows = Math.min(inputLines.length, Math.max(1, this.terminalSize.rows - 2));
    const visibleInput = inputLines.slice(-inputRows);
    const outputRows = Math.max(0, this.terminalSize.rows - inputRows - 2);
    const visibleOutput = this.output.slice(-outputRows);
    const rows = [...visibleOutput];
    while (rows.length < outputRows) rows.push('');

    rows.push(`${GRAY}${'─'.repeat(Math.max(1, this.terminalSize.cols))}${RESET}`);
    visibleInput.forEach((line, index) => rows.push(`${index === 0 ? `${CYAN}>${RESET} ` : '  '}${line}`));
    rows.push(`${GRAY}${this.statusText()}${RESET}`);

    const prefix = Array.from(input).slice(0, cursorCol).join('');
    const cursorInputRow = Math.max(0, prefix.split('\n').length - 1 - (inputLines.length - inputRows));
    const cursorLine = prefix.split('\n').at(-1) ?? '';
    const cursorRow = outputRows + 2 + cursorInputRow;
    const cursorColumn = 3 + Array.from(cursorLine).length;

    return `\u001b[H${rows.join('\n')}\u001b[J\u001b[${cursorRow};${cursorColumn}H`;
  }

  private statusText(): string {
    const running = this.status.running ? ' · 运行中…' : '';
    return `${this.status.model} · in ${fmtTokens(this.status.tokensIn)} out ${fmtTokens(this.status.tokensOut)} · ${money(this.status.costCny)}${running}`;
  }

  private trimOutput(): void {
    if (this.output.length > MAX_OUTPUT_LINES) this.output.splice(0, this.output.length - MAX_OUTPUT_LINES);
  }
}

function clean(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function fmtTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function money(costCny: number): string {
  if (costCny === 0) return '¥0';
  if (costCny < 0.01) return `¥${costCny.toFixed(5)}`;
  return `¥${costCny.toFixed(4)}`;
}
