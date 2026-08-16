/**
 * 权限确认抽屉。
 *
 * 取代原来的做法（退出 raw mode → 清屏 → readline 问 y/a/n/r）：
 * 抽屉是一层浮层，占输入区上方若干行，全屏不退、上文不丢、流式输出照常渲染。
 * 键盘在抽屉打开期间被接管，机制与 screen.ts 里的模型选择器一致。
 */

import type { PermissionAnswer, PermissionRequest } from '@confluence/core';
import { FG, BG, BOLD, RESET, paint, truncateToWidth } from './theme.js';

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

const RISK_LABEL: Record<string, { text: string; codes: string }> = {
  low: { text: '低风险 low', codes: FG.green },
  medium: { text: '中风险 medium', codes: FG.yellow },
  high: { text: '高风险 high · 副作用不可回滚', codes: FG.red },
};

export type DrawerKeyResult =
  | { type: 'pending' }
  | { type: 'answer'; answer: PermissionAnswer }
  /** 用户选了「拒绝并说明原因」：抽屉收起，输入行转为「原因：」 */
  | { type: 'ask_reason' };

export class ConfirmDrawer {
  private request?: PermissionRequest;
  private options: Option[] = BASE_OPTIONS;
  private index = 0;

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

  /** 渲染为浮层行；调用方把它塞进输入区上方，输出区自动让位。 */
  render(cols: number): string[] {
    const request = this.request;
    if (!request) return [];
    const width = Math.max(20, cols);
    const risk = RISK_LABEL[request.risk] ?? RISK_LABEL['medium']!;
    const title = paint(BOLD + FG.yellow, '⏸ 需要确认');
    const rightText = risk.text;
    const gap = Math.max(1, width - 12 - rightText.length);

    const lines: string[] = [];
    lines.push(truncateToWidth(`${title}${' '.repeat(gap)}${paint(risk.codes, rightText)}`, width));
    lines.push(truncateToWidth(request.summary, width));
    for (const item of request.affects.slice(0, 3)) lines.push(paint(FG.gray, truncateToWidth(`  ${item}`, width)));
    if (request.affects.length > 3) {
      lines.push(paint(FG.gray, `  …还有 ${request.affects.length - 3} 项`));
    }
    this.options.forEach((option, index) => {
      const selected = index === this.index;
      const text = ` ${selected ? '❯' : ' '} ${index + 1}　${option.label} ${option.en}`;
      lines.push(
        selected
          ? `${BG.bar}${FG.white}${truncateToWidth(text, width)}${RESET}`
          : paint(FG.gray, truncateToWidth(text, width)),
      );
    });
    lines.push(paint(FG.gray, truncateToWidth(`1-${this.options.length} 直选 · ↑↓ 移动 · Enter 确认 · Esc 拒绝`, width)));
    return lines;
  }
}
