/**
 * 启动横幅。cf 进入 TUI 的第一屏，也用于 cf run 的抬头。
 *
 * 宽度 >= MIN_FULL_COLS 时输出块字标识 + 四项信息；更窄时降级成单行。
 * 标识左半 CF 的 C 用 cyan、F 用 magenta —— 与装订线里「用户/思考」两色同源。
 */

import { FG, RESET, BOLD, paint, stringWidth, truncateToWidth } from './theme.js';

const MARK = ['▄████▖ ██████', '██   ▘ ██▄▄▄ ', '██   ▖ ██▀▀▀ ', '▀████▘ ██    '];
/** MARK 每行第 7 列是分隔空格，左右各 6 列 */
const MARK_SPLIT = 6;
const MIN_FULL_COLS = 60;

export interface BannerInfo {
  version: string;
  model: string;
  /** 可切换的模型总数，用于「另有 N 个可选」 */
  modelCount?: number;
  mode: 'readonly' | 'step_confirm' | 'auto_edit' | 'smart' | 'full_auto';
  cwd: string;
  /** 沙箱实现名；不可用时传 undefined */
  sandbox?: 'seatbelt' | 'bubblewrap';
  /** 未配置任何可用服务商时为 true，横幅转成首启形态 */
  firstRun?: boolean;
  secretBackend?: string;
}

const MODE_NOTE: Record<BannerInfo['mode'], string> = {
  readonly: '只读，不写盘',
  step_confirm: '每步都确认',
  auto_edit: '自动改文件，命令仍确认',
  smart: '写入前确认，命令需授权',
  full_auto: '全自动，强制拒绝清单仍生效',
};

function markRow(index: number): string {
  const row = MARK[index]!;
  return `${paint(FG.cyan, row.slice(0, MARK_SPLIT))} ${paint(FG.magenta, row.slice(MARK_SPLIT + 1))}`;
}

/** 详细横幅：标识 + 模型/权限/沙箱/目录。返回逐行文本，不含结尾换行。 */
export function renderBanner(info: BannerInfo, cols: number): string[] {
  if (cols < MIN_FULL_COLS) return [renderCompactBanner(info, cols)];
  if (info.firstRun) return renderFirstRun(info, cols);

  const label = (text: string) => paint(FG.gray, text.padEnd(4, '　'));
  const rows = [
    `${paint(BOLD, 'Confluence 汇流')} ${paint(FG.gray, `v${info.version}`)}`,
    `${label('模型')} ${info.model}${info.modelCount && info.modelCount > 1 ? paint(FG.gray, `  · 另有 ${info.modelCount - 1} 个可选，/model 切换`) : ''}`,
    `${label('权限')} ${paint(FG.yellow, info.mode)}${paint(FG.gray, `  · ${MODE_NOTE[info.mode]}`)}`,
    info.sandbox
      ? `${label('沙箱')} ${paint(FG.green, info.sandbox)}${paint(FG.gray, '  · 内核强制')}`
      : `${label('沙箱')} ${paint(FG.yellow, '不可用')}${paint(FG.gray, '  · 运行 cf doctor 查看修法')}`,
    `${label('目录')} ${info.cwd}`,
  ];

  const lines: string[] = [];
  const height = Math.max(MARK.length, rows.length);
  for (let index = 0; index < height; index++) {
    const mark = index < MARK.length ? markRow(index) : ' '.repeat(MARK[0]!.length);
    const text = rows[index] ?? '';
    lines.push(truncateToWidth(`${mark}   ${text}`, cols));
  }
  lines.push('');
  lines.push(paint(FG.gray, truncateToWidth('输入任务并回车 · /help 查看命令 · 双击 ^C 退出', cols)));
  return lines;
}

/** 窄终端 / cf run 抬头用的单行形态。 */
export function renderCompactBanner(info: BannerInfo, cols: number): string {
  const sandbox = info.sandbox ? paint(FG.green, info.sandbox) : paint(FG.yellow, '无沙箱');
  const text = [
    `${paint(BOLD + FG.cyan, 'Confluence')} ${paint(FG.gray, `v${info.version}`)}`,
    info.model,
    paint(FG.yellow, info.mode),
    sandbox,
  ].join(paint(FG.gray, ' · '));
  return truncateToWidth(`${paint(RESET, '╋━▶')} ${text}`, cols);
}

/** 首次启动 / doctor 有问题时：同一横幅 + 待办清单。 */
function renderFirstRun(info: BannerInfo, cols: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < MARK.length; index++) {
    const head =
      index === 0
        ? `${paint(BOLD, 'Confluence 汇流')} ${paint(FG.gray, `v${info.version}`)}`
        : index === 1
          ? paint(FG.yellow, '尚未配置模型')
          : '';
    lines.push(truncateToWidth(`${markRow(index)}   ${head}`, cols));
  }
  lines.push('');
  lines.push(
    info.sandbox
      ? `${paint(FG.green, '✓')} 沙箱可用 ${paint(FG.gray, `${info.sandbox}（内核强制）`)}`
      : `${paint(FG.yellow, '!')} 沙箱不可用 ${paint(FG.gray, '运行 cf doctor 查看修法')}`,
  );
  lines.push(
    info.secretBackend
      ? `${paint(FG.green, '✓')} 密钥后端 ${paint(FG.gray, `${info.secretBackend} · 不会明文落盘`)}`
      : `${paint(FG.yellow, '!')} 没有可用的密钥后端 ${paint(FG.gray, 'cf config secret-backend')}`,
  );
  lines.push(`${paint(FG.yellow, '!')} 还没有服务商 ${paint(FG.gray, '运行 ')}${paint(FG.blue, 'cf provider add deepseek')}`);
  lines.push('');
  lines.push(paint(FG.gray, '按 Enter 现在就配 · Esc 稍后'));
  return lines.map((line) => (stringWidth(line) > cols ? truncateToWidth(line, cols) : line));
}
