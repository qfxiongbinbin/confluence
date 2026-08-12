import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const useColor = stdout.isTTY && !process.env['NO_COLOR'];
const wrap = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export function write(s: string): void {
  stdout.write(s);
}

export function line(s = ''): void {
  stdout.write(`${s}\n`);
}

export function heading(s: string): void {
  line(`\n${c.bold(s)}`);
  line(c.gray('─'.repeat(Math.min(60, s.length * 2))));
}

export function kv(k: string, v: string, pad = 16): void {
  line(`  ${c.gray(k.padEnd(pad))}${v}`);
}

export function table(rows: string[][], headers?: string[]): void {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return;
  const widths: number[] = [];
  for (const r of all) {
    r.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell));
    });
  }
  const render = (r: string[]) => r.map((cell, i) => cell + ' '.repeat((widths[i] ?? 0) - displayWidth(cell))).join('  ');
  if (headers) {
    line(`  ${c.bold(render(headers))}`);
    line(`  ${c.gray(widths.map((w) => '─'.repeat(w)).join('  '))}`);
  }
  for (const r of rows) line(`  ${render(r)}`);
}

/** CJK characters occupy two columns in a terminal. */
function displayWidth(s: string): number {
  let n = 0;
  for (const ch of stripAnsi(s)) {
    const code = ch.codePointAt(0)!;
    n += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) ? 2 : 1;
  }
  return n;
}

const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '');

export function ok(s: string): void {
  line(`${c.green('✓')} ${s}`);
}
export function warn(s: string): void {
  line(`${c.yellow('!')} ${s}`);
}
export function err(s: string): void {
  line(`${c.red('✗')} ${s}`);
}
export function info(s: string): void {
  line(`${c.blue('·')} ${s}`);
}

export async function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    if (!opts.hidden) return (await rl.question(question)).trim();
    // Mask input for secrets.
    const orig = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
      if (s.includes(question)) stdout.write(s);
      else stdout.write('*');
    };
    const answer = await rl.question(question);
    if (orig) (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput = orig;
    stdout.write('\n');
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, choices: { key: string; label: string }[]): Promise<string> {
  line(question);
  for (const ch of choices) line(`  ${c.bold(`[${ch.key}]`)} ${ch.label}`);
  for (;;) {
    const a = (await prompt('> ')).toLowerCase();
    const hit = choices.find((ch) => ch.key.toLowerCase() === a);
    if (hit) return hit.key;
    warn(`请输入 ${choices.map((ch) => ch.key).join(' / ')}`);
  }
}

export function money(cny: number): string {
  if (cny === 0) return '¥0';
  if (cny < 0.01) return `¥${cny.toFixed(5)}`;
  return `¥${cny.toFixed(4)}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
