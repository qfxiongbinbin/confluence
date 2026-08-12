/** Minimal SSE reader over a fetch Response body. */

export interface SseMessage {
  event?: string;
  data: string;
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line. Handle both \n\n and \r\n\r\n.
      let idx: number;
      while ((idx = findBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, idx.valueOf());
        buffer = buffer.slice(idx + boundaryLength(buffer, idx));
        const msg = parseBlock(raw);
        if (msg) yield msg;
      }
    }
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

function findBoundary(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function boundaryLength(buf: string, idx: number): number {
  return buf.startsWith('\r\n\r\n', idx) ? 4 : 2;
}

function parseBlock(block: string): SseMessage | null {
  const trimmed = block.trim();
  if (!trimmed) return null;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && !event) return null;
  return event === undefined ? { data: dataLines.join('\n') } : { event, data: dataLines.join('\n') };
}
