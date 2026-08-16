/**
 * 状态栏。原来是一整行灰字，各项分不出主次；改成分段色块：
 * 模式与花费用语义色，运行中单独一段，其余保持低对比。
 */

import { FG, BG, RESET, paint, stringWidth, truncateToWidth } from './theme.js';

export interface StatusBar {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costCny: number;
  mode: string;
  running: boolean;
  /** 本次运行已耗时（秒），仅 running 时显示 */
  elapsedSec?: number;
  /** 输出区向上滚动的行数，>0 时提示回看状态 */
  scrolled?: number;
}

interface Segment {
  text: string;
  codes: string;
}

function segment(text: string, codes: string): Segment {
  return { text: ` ${text} `, codes };
}

export function renderStatusBar(status: StatusBar, cols: number): string {
  const segments: Segment[] = [
    segment('AGENT', BG.barActive + FG.white),
    segment(status.mode, BG.bar + FG.yellow),
    segment(status.model, BG.barDim),
    segment(`in ${fmtTokens(status.tokensIn)}  out ${fmtTokens(status.tokensOut)}`, BG.barDim + FG.gray),
    segment(money(status.costCny), BG.barDim + FG.green),
    status.running
      ? segment(`● 运行中${status.elapsedSec ? ` ${status.elapsedSec}s` : ''}`, BG.barDim + FG.magenta)
      : segment('○ 空闲', BG.barDim + FG.gray),
  ];

  const hint = status.scrolled ? `↑${status.scrolled} 行 · End 回到底部` : status.running ? '^C 中断' : 'PgUp 回看';
  const widthOf = (segs: Segment[]) => segs.reduce((total, s) => total + stringWidth(s.text), 0);
  const hintWidth = stringWidth(hint);
  const fits = (segs: Segment[]) => widthOf(segs) + hintWidth + 2 <= cols;
  const fitsPlain = (segs: Segment[]) => widthOf(segs) <= cols;

  // 窄终端逐级降级，任何情况下整行显示宽度绝不超过 cols —— 状态栏一旦折行
  // 会把整个 TUI 布局顶掉。让位顺序：
  //   回看中（↑N 行是状态反馈）：AGENT 徽标 → 花费 → token 计数，提示最后丢；
  //   平时：右侧提示先丢，再丢 AGENT 徽标 → 花费 → token 计数。
  let shown = segments;
  let withHint = fits(shown);
  const shed = (fitsFn: (segs: Segment[]) => boolean): boolean => {
    const droppable: ((s: Segment) => boolean)[] = [
      (s) => s.text === ' AGENT ',
      (s) => s.text.trim().startsWith('¥'),
      (s) => s.text.startsWith(' in '),
    ];
    for (const drop of droppable) {
      shown = shown.filter((s) => !drop(s));
      if (fitsFn(shown)) return true;
    }
    return fitsFn(shown);
  };
  if (!withHint) {
    if ((status.scrolled ?? 0) > 0) withHint = shed(fits);
    else {
      withHint = false;
      if (!fitsPlain(shown)) shed(fitsPlain);
    }
  }

  const left = shown.map((s) => paint(s.codes, s.text)).join('');
  const tail = withHint
    ? `${' '.repeat(Math.max(1, cols - widthOf(shown) - hintWidth - 1))}${paint(FG.gray, hint)}`
    : '';
  return `${truncateToWidth(`${left}${tail}`, cols)}${RESET}`;
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
