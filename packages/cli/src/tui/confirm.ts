/**
 * 权限确认抽屉。
 *
 * 取代原来的做法（退出 raw mode → 清屏 → readline 问 y/a/n/r）：
 * 抽屉是一层浮层，占输入区上方若干行，全屏不退、上文不丢、流式输出照常渲染。
 * 键盘在抽屉打开期间被接管，机制与 screen.ts 里的模型选择器一致。
 */

import type { PermissionAnswer, PermissionRequest } from '@confluence/core';
import { FG, BG, BOLD, RESET, colorsEnabled, paint, padToWidth, stringWidth, truncateToWidth } from './theme.js';

interface Option {
  label: string;
  en: string;
  answer: PermissionAnswer | 'reason';
}

const BASE_OPTIONS: Option[] = [
  { label: '允许这一次', en: 'Allow once', answer: { decision: 'allow' } },
  { label: '本会话总是允许', en: 'Always', answer: { decision: 'allow_always' } },
  { label: '拒绝', en: 'Deny', answer: { decision: 'deny' } },
  { label: '拒绝并说明原因', en: 'Deny with reason', answer: 'reason' },
];

const REVIEW_OPTION: Option = { label: '查看完整 diff', en: 'Review', answer: 'reason' };

/**
 * 风险等级 → 文案 + 主色。
 * 主色同时决定边框颜色：不用读字，边框是红的就知道这条不可回滚。
 * `critical` 必须单列一项 —— 缺了它 run_command（risk: 'critical'）会掉进
 * 默认分支被标成「中风险 medium」，正好把最危险的一类说成最轻的。
 */
const RISK_LABEL: Record<string, { text: string; codes: string }> = {
  low: { text: '低风险 low', codes: FG.green },
  medium: { text: '中风险 medium', codes: FG.yellow },
  high: { text: '高风险 high', codes: FG.red },
  critical: { text: '极高风险 critical', codes: FG.red },
};

/** 这次确认的性质，由 affects 的形态推出（engine.describe 的编码约定）。 */
type Facet = 'write' | 'execute' | 'network';

function facetOf(request: PermissionRequest): Facet {
  if (request.affects.some((item) => item.startsWith('$ '))) return 'execute';
  if (request.affects.some((item) => item.startsWith('→ '))) return 'network';
  return 'write';
}

/** 右上角风险标签的后缀：一句话说清「影响到哪」。 */
function scopeOf(request: PermissionRequest, facet: Facet, workingDir?: string): string | undefined {
  if (facet === 'execute') return '副作用不可回滚';
  if (facet === 'network') return '出网请求';
  const paths = request.affects.filter((item) => item.startsWith('/'));
  if (!workingDir || paths.length === 0) return undefined;
  const root = workingDir.endsWith('/') ? workingDir.slice(0, -1) : workingDir;
  return paths.every((p) => p === root || p.startsWith(`${root}/`)) ? '工作目录内' : '工作目录外';
}

/** summary 下面那行灰字：说清「批准之后还能不能反悔」。 */
function noteOf(request: PermissionRequest, facet: Facet): string {
  if (facet === 'execute') return `${request.toolName} 的副作用不在回滚范围内`;
  if (facet === 'network') return '响应内容会进入上下文';
  return '已自动快照，可 cf task rollback';
}

export type DrawerKeyResult =
  | { type: 'pending' }
  | { type: 'answer'; answer: PermissionAnswer }
  /** 用户选了「拒绝并说明原因」：抽屉收起，输入行转为「原因：」 */
  | { type: 'ask_reason' };

export class ConfirmDrawer {
  private request?: PermissionRequest;
  private options: Option[] = BASE_OPTIONS;
  private index = 0;

  /** 用于判断改动是否落在工作目录内；不传则不显示作用域后缀。 */
  constructor(private readonly workingDir?: string) {}

  get open(): boolean {
    return this.request !== undefined;
  }

  /** showReview：改动多、值得先看 diff 时多给一项 */
  show(request: PermissionRequest, showReview = false): void {
    this.request = request;
    this.options = showReview ? [...BASE_OPTIONS, REVIEW_OPTION] : BASE_OPTIONS;
    this.index = 0;
  }

  close(): void {
    this.request = undefined;
    this.index = 0;
  }

  /** 抽屉打开期间接管全部按键；返回 pending 表示继续等待。 */
  handleKey(key: string): DrawerKeyResult {
    if (!this.request) return { type: 'pending' };
    const last = this.options.length - 1;
    const digit = Number(key);
    if (Number.isInteger(digit) && digit >= 1 && digit <= this.options.length) {
      return this.pick(digit - 1);
    }
    switch (key) {
      case 'up':
        this.index = Math.max(0, this.index - 1);
        return { type: 'pending' };
      case 'down':
        this.index = Math.min(last, this.index + 1);
        return { type: 'pending' };
      case 'enter':
        return this.pick(this.index);
      case 'escape':
        // Esc 等同拒绝，但不退出会话 —— 与选择器的 Esc 语义（取消）一致
        this.close();
        return { type: 'answer', answer: { decision: 'deny' } };
      default:
        return { type: 'pending' };
    }
  }

  private pick(index: number): DrawerKeyResult {
    const option = this.options[index];
    if (!option) return { type: 'pending' };
    this.close();
    if (option.answer === 'reason') return { type: 'ask_reason' };
    return { type: 'answer', answer: option.answer };
  }

  /**
   * 渲染为浮层行；调用方把它塞进输入区上方，输出区自动让位。
   *
   * 版式（对齐设计稿）：
   * - 盒宽铺满终端：抽屉是「在等你」的那一刻的主角，不缩成一小块飘在角落；
   * - 细线边框（┌ ─ ┐ │ └ ─ ┘），颜色跟随风险等级：低=绿、中=琥珀、高/极高=红。
   *   不用读字，边框是红的就知道这条不可回滚；
   * - 盒内不铺底色，与输出区保持同一底色，只有选中项用高亮条拉通盒内宽度；
   * - 正文一律给显式前景色，不指望终端默认前景恰好合适。
   */
  render(cols: number): string[] {
    const request = this.request;
    if (!request) return [];
    const risk = RISK_LABEL[request.risk] ?? RISK_LABEL['medium']!;
    const facet = facetOf(request);
    const scope = scopeOf(request, facet, this.workingDir);

    const titleText = '⏸ 需要确认';
    const chipText = scope ? `${risk.text} · ${scope}` : risk.text;
    const noteText = noteOf(request, facet);
    const hintText = `1-${this.options.length} 直选 · ↑↓ 移动 · Enter 确认 · Esc 拒绝`;
    const affects = request.affects.slice(0, 3);
    const overflowNote = request.affects.length > 3 ? `…还有 ${request.affects.length - 3} 项` : undefined;
    const optionTexts = this.options.map(
      (option, index) => `${index === this.index ? '❯' : ' '} ${index + 1}  ${option.label} ${option.en}`,
    );

    const width = Math.max(10, cols);
    const inner = width - 4; // 两侧边框各 1 列 + 两侧各 1 列内边距
    const colored = colorsEnabled();
    const EDGE = risk.codes; // 边框色 = 风险主色

    /** 盒内一行：两端 1 列细线竖边，中间内容 + 空格补齐到内宽。 */
    const row = (rendered: string): string => {
      const clipped = truncateToWidth(rendered, inner);
      const pad = ' '.repeat(Math.max(0, inner - stringWidth(clipped)));
      if (!colored) return `│ ${clipped}${pad} │`;
      // 截断可能把内容的 RESET 切掉，补一个兜底，避免颜色渗到右边框
      return `${EDGE}│${RESET} ${clipped}${RESET}${pad} ${EDGE}│${RESET}`;
    };

    /** 上/下边：整条细线，与竖边同色同粗。 */
    const border = (left: string, right: string): string => {
      const line = `${left}${'─'.repeat(width - 2)}${right}`;
      return colored ? `${EDGE}${line}${RESET}` : line;
    };

    const lines: string[] = [];
    lines.push(border('┌', '┐'));

    // 标题行：左「⏸ 需要确认」，右风险标签，按显示宽度右对齐
    const gap = Math.max(1, inner - stringWidth(titleText) - stringWidth(chipText));
    lines.push(row(`${paint(BOLD + risk.codes, titleText)}${' '.repeat(gap)}${paint(risk.codes, chipText)}`));
    lines.push(row(''));

    lines.push(row(paint(FG.white, request.summary)));
    lines.push(row(paint(FG.gray, noteText)));
    for (const item of affects) lines.push(row(paint(FG.gray, item)));
    if (overflowNote) lines.push(row(paint(FG.gray, overflowNote)));
    lines.push(row(''));

    optionTexts.forEach((text, index) => {
      const selected = index === this.index;
      if (selected && colored) {
        // 补空格要在底色序列「里面」：高亮条才能拉通整个盒内宽度
        const padded = padToWidth(truncateToWidth(text, inner), inner);
        lines.push(row(`${BG.bar}${FG.white}${padded}${RESET}`));
      } else {
        // NO_COLOR 下不能拼裸转义序列，选中项靠 ❯ 符号自己表明身份
        lines.push(row(selected ? text : paint(FG.gray, text)));
      }
    });
    lines.push(row(''));

    lines.push(row(paint(FG.gray, hintText)));
    lines.push(border('└', '┘'));
    return lines;
  }
}
