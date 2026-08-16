/**
 * TUI 主题：ANSI 色号、行类型 → 装订线映射、显示宽度工具。
 * 零依赖，可被 screen.ts / banner.ts / confirm.ts 共用。
 *
 * 设计约束：每类内容占固定 2 列装订线（符号 + 空格），符号先行、颜色其次。
 * 终端主题差异大或 NO_COLOR 时，仅凭符号与缩进仍可分辨内容类别。
 */

export const RESET = '\u001b[0m';
export const BOLD = '\u001b[1m';
export const DIM = '\u001b[2m';
export const INVERT = '\u001b[7m';

export const FG = {
  gray: '\u001b[90m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  white: '\u001b[97m',
} as const;

export const BG = {
  addSoft: '\u001b[48;5;22m',
  delSoft: '\u001b[48;5;52m',
  bar: '\u001b[48;5;236m',
  barActive: '\u001b[48;5;25m',
  barDim: '\u001b[48;5;234m',
} as const;

/** NO_COLOR / 非 TTY 时全部转义序列置空 —— 只保留装订线符号。 */
let colorEnabled = true;
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}
export function paint(codes: string, text: string): string {
  return colorEnabled && codes ? `${codes}${text}${RESET}` : text;
}

export type LineKind =
  | 'user'
  | 'reasoning'
  | 'normal'
  | 'tool-call'
  | 'tool-out'
  | 'ok'
  | 'error'
  | 'warn'
  | 'file-changed'
  | 'diff-meta'
  | 'diff-add'
  | 'diff-del'
  | 'pending'
  | 'muted';

interface LineStyle {
  /** 装订线符号，占 1 列；渲染时补一个空格凑满 2 列 */
  gutter: string;
  gutterCodes: string;
  textCodes: string;
}

export const GUTTER_WIDTH = 2;

export const LINE_STYLES: Record<LineKind, LineStyle> = {
  user: { gutter: '❯', gutterCodes: FG.cyan, textCodes: FG.cyan },
  reasoning: { gutter: '✻', gutterCodes: FG.magenta + DIM, textCodes: FG.magenta + DIM },
  normal: { gutter: ' ', gutterCodes: '', textCodes: '' },
  'tool-call': { gutter: '▸', gutterCodes: FG.blue, textCodes: FG.blue },
  'tool-out': { gutter: '│', gutterCodes: FG.gray + DIM, textCodes: FG.gray },
  ok: { gutter: '✓', gutterCodes: FG.green, textCodes: FG.green },
  error: { gutter: '✗', gutterCodes: FG.red, textCodes: FG.red },
  warn: { gutter: '!', gutterCodes: FG.yellow, textCodes: FG.yellow },
  'file-changed': { gutter: '✎', gutterCodes: FG.yellow, textCodes: FG.yellow },
  'diff-meta': { gutter: ' ', gutterCodes: '', textCodes: BOLD + FG.cyan },
  // diff 用行底色而不是只改前景：+ 和 - 在窄终端里被折行时仍然分得清
  'diff-add': { gutter: ' ', gutterCodes: '', textCodes: FG.green + BG.addSoft },
  'diff-del': { gutter: ' ', gutterCodes: '', textCodes: FG.red + BG.delSoft },
  // 全场唯一的反白，出现即表示「在等你」
  pending: { gutter: '⏸', gutterCodes: INVERT + FG.yellow, textCodes: FG.yellow },
  muted: { gutter: ' ', gutterCodes: '', textCodes: FG.gray },
};

/** 渲染一行：装订线 + 正文（+ 可选的灰色尾注，如耗时）。 */
export function renderLine(kind: LineKind, text: string, meta?: string): string {
  const style = LINE_STYLES[kind];
  const gutter = paint(style.gutterCodes, style.gutter);
  const body = paint(style.textCodes, text);
  const tail = meta ? ` ${paint(FG.gray, meta)}` : '';
  return `${gutter} ${body}${tail}`;
}

/** 正文的续行缩进（软换行、多行工具输出对齐用）。 */
export const CONTINUATION = ' '.repeat(GUTTER_WIDTH);

interface DisplayUnit {
  text: string;
  width: number;
}

/** ANSI 转义序列记 0 宽，其余按码点计宽。 */
export function unitsOf(text: string): DisplayUnit[] {
  const units: DisplayUnit[] = [];
  const re = /(\u001b\[[0-9;?]*[A-Za-z]|[\s\S])/gu;
  for (const match of text.matchAll(re)) {
    const unit = match[1]!;
    units.push(unit.startsWith('\u001b') ? { text: unit, width: 0 } : { text: unit, width: charWidth(unit.codePointAt(0)!) });
  }
  return units;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const unit of unitsOf(text)) width += unit.width;
  return width;
}

export function charWidth(codePoint: number): number {
  if (codePoint === 0xfe0f || codePoint === 0x200d) return 0;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x16fe0 && codePoint <= 0x16fe4) ||
    (codePoint >= 0x17000 && codePoint <= 0x18aff) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** 按显示宽度截断（宽字符不拆半、ANSI 0 宽）。 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  let width = 0;
  const kept: string[] = [];
  for (const unit of unitsOf(text)) {
    if (width + unit.width > maxWidth) break;
    kept.push(unit.text);
    width += unit.width;
  }
  return kept.join('');
}

/** 右侧补空格到指定显示宽度（状态栏分段用）。 */
export function padToWidth(text: string, width: number): string {
  const pad = width - stringWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}
