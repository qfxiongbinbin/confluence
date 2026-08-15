import { stdin, stdout } from 'node:process';

export interface TermSize {
  cols: number;
  rows: number;
}

export class Term {
  enterRawMode(): void {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      throw new Error('TUI 需要在交互式终端中运行');
    }
    stdin.setRawMode(true);
    stdin.resume();
  }

  exitRawMode(): void {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
  }

  enterAltScreen(): void {
    this.write('\u001b[?1049h\u001b[?2004h');
  }

  exitAltScreen(): void {
    this.write('\u001b[?2004l\u001b[?1049l');
  }

  hideCursor(): void {
    this.write('\u001b[?25l');
  }

  showCursor(): void {
    this.write('\u001b[?25h');
  }

  size(): TermSize {
    return { cols: stdout.columns || 80, rows: stdout.rows || 24 };
  }

  onResize(cb: (size: TermSize) => void): () => void {
    const listener = () => cb(this.size());
    stdout.on('resize', listener);
    return () => stdout.off('resize', listener);
  }

  onData(cb: (data: Buffer) => void): () => void {
    stdin.on('data', cb);
    return () => stdin.off('data', cb);
  }

  write(text: string): void {
    stdout.write(text);
  }
}
