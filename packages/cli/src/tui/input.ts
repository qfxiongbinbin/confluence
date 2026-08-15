export interface InputState {
  lines: string[];
  cursor: { row: number; col: number };
}

export interface DecodedKey {
  key: string;
  consumed: number;
}

const KEY_SEQUENCES = new Map<string, string>([
  ['\u001b[A', 'up'],
  ['\u001b[B', 'down'],
  ['\u001b[C', 'right'],
  ['\u001b[D', 'left'],
  ['\u001b[H', 'home'],
  ['\u001b[F', 'end'],
  ['\u001b[3~', 'delete'],
  ['\u001b[1~', 'home'],
  ['\u001b[4~', 'end'],
  ['\u001b[200~', 'paste-start'],
  ['\u001b[201~', 'paste-end'],
]);

const CONTROL_KEYS = new Map<number, string>([
  [0x0d, 'enter'],
  [0x0a, 'enter'],
  [0x7f, 'backspace'],
  [0x08, 'backspace'],
  [0x03, 'ctrl-c'],
  [0x04, 'ctrl-d'],
  [0x01, 'home'],
  [0x05, 'end'],
  [0x0b, 'delete-line'],
  [0x15, 'clear-line'],
]);

export function decodeKey(buf: Buffer): DecodedKey {
  if (buf.length === 0) return { key: '', consumed: 0 };

  if (buf[0] === 0x1b) {
    for (const [sequence, key] of KEY_SEQUENCES) {
      const bytes = Buffer.from(sequence);
      if (buf.length >= bytes.length && buf.subarray(0, bytes.length).equals(bytes)) {
        return { key, consumed: bytes.length };
      }
    }
    const text = buf.toString('utf8');
    const knownPrefix = [...KEY_SEQUENCES.keys()].some((sequence) => sequence.startsWith(text));
    if (knownPrefix) return { key: '', consumed: 0 };
    return { key: 'escape', consumed: 1 };
  }

  const control = CONTROL_KEYS.get(buf[0]!);
  if (control) return { key: control, consumed: 1 };

  const byteLength = utf8ByteLength(buf[0]!);
  if (byteLength === 0) return { key: '', consumed: 1 };
  if (buf.length < byteLength) return { key: '', consumed: 0 };

  const bytes = buf.subarray(0, byteLength);
  const key = bytes.toString('utf8');
  if (key === '\ufffd') return { key: '', consumed: 1 };
  return { key, consumed: byteLength };
}

function utf8ByteLength(firstByte: number): number {
  if (firstByte <= 0x7f) return firstByte >= 0x20 ? 1 : 0;
  if ((firstByte & 0xe0) === 0xc0) return 2;
  if ((firstByte & 0xf0) === 0xe0) return 3;
  if ((firstByte & 0xf8) === 0xf0) return 4;
  return 0;
}

function chars(text: string): string[] {
  return Array.from(text);
}

export class InputBuffer {
  readonly state: InputState = { lines: [''], cursor: { row: 0, col: 0 } };
  private readonly historyLimit: number;
  private history: string[] = [];
  private historyIndex = 0;
  private historyDraft = '';

  constructor(historyLimit = 100) {
    this.historyLimit = Math.max(1, historyLimit);
  }

  insert(text: string): void {
    if (!text) return;
    this.leaveHistory();
    const normalized = text.replace(/\r\n?/g, '\n');
    const parts = normalized.split('\n');
    const row = this.state.cursor.row;
    const col = this.state.cursor.col;
    const current = chars(this.state.lines[row]!);
    const before = current.slice(0, col).join('');
    const after = current.slice(col).join('');

    if (parts.length === 1) {
      this.state.lines[row] = `${before}${parts[0]!}${after}`;
      this.state.cursor.col += chars(parts[0]!).length;
      return;
    }

    const replacement = [
      `${before}${parts[0]!}`,
      ...parts.slice(1, -1),
      `${parts.at(-1)!}${after}`,
    ];
    this.state.lines.splice(row, 1, ...replacement);
    this.state.cursor.row += replacement.length - 1;
    this.state.cursor.col = chars(parts.at(-1)!).length;
  }

  backspace(): void {
    this.leaveHistory();
    const { row, col } = this.state.cursor;
    if (col > 0) {
      const line = chars(this.state.lines[row]!);
      line.splice(col - 1, 1);
      this.state.lines[row] = line.join('');
      this.state.cursor.col--;
      return;
    }
    if (row === 0) return;
    const previousLength = chars(this.state.lines[row - 1]!).length;
    this.state.lines[row - 1] += this.state.lines[row]!;
    this.state.lines.splice(row, 1);
    this.state.cursor.row--;
    this.state.cursor.col = previousLength;
  }

  deleteForward(): void {
    this.leaveHistory();
    const { row, col } = this.state.cursor;
    const line = chars(this.state.lines[row]!);
    if (col < line.length) {
      line.splice(col, 1);
      this.state.lines[row] = line.join('');
      return;
    }
    if (row >= this.state.lines.length - 1) return;
    this.state.lines[row] += this.state.lines[row + 1]!;
    this.state.lines.splice(row + 1, 1);
  }

  left(): void {
    const { row, col } = this.state.cursor;
    if (col > 0) {
      this.state.cursor.col--;
    } else if (row > 0) {
      this.state.cursor.row--;
      this.state.cursor.col = chars(this.state.lines[row - 1]!).length;
    }
  }

  right(): void {
    const { row, col } = this.state.cursor;
    if (col < chars(this.state.lines[row]!).length) {
      this.state.cursor.col++;
    } else if (row < this.state.lines.length - 1) {
      this.state.cursor.row++;
      this.state.cursor.col = 0;
    }
  }

  home(): void {
    this.state.cursor.col = 0;
  }

  end(): void {
    this.state.cursor.col = chars(this.state.lines[this.state.cursor.row]!).length;
  }

  up(): void {
    if (this.state.lines.length === 1) {
      this.historyUp();
      return;
    }
    if (this.state.cursor.row === 0) return;
    this.state.cursor.row--;
    this.clampColumn();
  }

  down(): void {
    if (this.state.lines.length === 1) {
      this.historyDown();
      return;
    }
    if (this.state.cursor.row >= this.state.lines.length - 1) return;
    this.state.cursor.row++;
    this.clampColumn();
  }

  handleKey(key: string): void {
    switch (key) {
      case 'backspace': this.backspace(); break;
      case 'delete': this.deleteForward(); break;
      case 'left': this.left(); break;
      case 'right': this.right(); break;
      case 'home': this.home(); break;
      case 'end': this.end(); break;
      case 'up': this.up(); break;
      case 'down': this.down(); break;
      case 'delete-line': this.deleteToEnd(); break;
      case 'clear-line': this.clear(); break;
      default:
        if (key.length > 0 && !key.startsWith('ctrl-') && key !== 'enter' && key !== 'escape') this.insert(key);
    }
  }

  get value(): string {
    return this.state.lines.join('\n');
  }

  get cursorOffset(): number {
    let offset = 0;
    for (let row = 0; row < this.state.cursor.row; row++) {
      offset += chars(this.state.lines[row]!).length + 1;
    }
    return offset + this.state.cursor.col;
  }

  commit(): string {
    const value = this.value;
    if (value) {
      if (this.history.at(-1) !== value) this.history.push(value);
      if (this.history.length > this.historyLimit) this.history.splice(0, this.history.length - this.historyLimit);
    }
    this.clear(false);
    return value;
  }

  clear(resetHistory = true): void {
    this.state.lines.splice(0, this.state.lines.length, '');
    this.state.cursor.row = 0;
    this.state.cursor.col = 0;
    if (resetHistory) this.leaveHistory();
    else {
      this.historyIndex = this.history.length;
      this.historyDraft = '';
    }
  }

  private deleteToEnd(): void {
    this.leaveHistory();
    const { row, col } = this.state.cursor;
    this.state.lines[row] = chars(this.state.lines[row]!).slice(0, col).join('');
    this.state.lines.splice(row + 1);
  }

  private historyUp(): void {
    if (this.history.length === 0 || this.historyIndex === 0) return;
    if (this.historyIndex === this.history.length) this.historyDraft = this.value;
    this.historyIndex--;
    this.loadHistory(this.history[this.historyIndex]!);
  }

  private historyDown(): void {
    if (this.historyIndex >= this.history.length) return;
    this.historyIndex++;
    this.loadHistory(this.historyIndex === this.history.length ? this.historyDraft : this.history[this.historyIndex]!);
  }

  private loadHistory(value: string): void {
    const lines = value.replace(/\r\n?/g, '\n').split('\n');
    this.state.lines.splice(0, this.state.lines.length, ...lines);
    this.state.cursor.row = lines.length - 1;
    this.state.cursor.col = chars(lines.at(-1)!).length;
  }

  private leaveHistory(): void {
    this.historyIndex = this.history.length;
    this.historyDraft = '';
  }

  private clampColumn(): void {
    this.state.cursor.col = Math.min(this.state.cursor.col, chars(this.state.lines[this.state.cursor.row]!).length);
  }
}
