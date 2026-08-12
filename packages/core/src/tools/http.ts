import { num, str, type Tool, type ToolResult } from './types.js';

export const httpFetchTool: Tool = {
  name: 'http_fetch',
  description: '抓取一个网页并转成 Markdown 文本。仅在任务允许网络出站时可用。',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的 URL（http/https）' },
      max_chars: { type: 'number', description: '返回的最大字符数，默认 20000' },
    },
    required: ['url'],
  },
  footprint(args) {
    const raw = str(args, 'url');
    let host = raw;
    try {
      host = new URL(raw).host;
    } catch {
      /* leave as-is; execute() will reject it */
    }
    return { access: 'network', host };
  },
  async execute(args, ctx): Promise<ToolResult> {
    const raw = str(args, 'url');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, content: `URL 无效：${raw}`, summary: 'URL 无效' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, content: `仅支持 http/https，收到 ${url.protocol}`, summary: '协议不支持' };
    }

    const maxChars = Math.max(1000, num(args, 'max_chars', 20_000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(60_000, ctx.timeoutMs));
    const onAbort = () => controller.abort();
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'Confluence/0.1 (+https://example.invalid)' },
      });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok) {
        return { ok: false, content: `HTTP ${res.status} ${res.statusText}`, summary: `抓取失败 ${res.status}` };
      }
      const text = await res.text();
      const body = type.includes('html') ? htmlToText(text) : text;
      const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n\n[已截断，共 ${body.length} 字符]` : body;
      return {
        ok: true,
        content: `# ${url.href}\n\n${clipped}`,
        summary: `抓取 ${url.host}（${body.length} 字符）`,
        meta: { status: res.status, contentType: type },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, content: `抓取失败：${msg}`, summary: `抓取失败 ${url.host}` };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
    }
  },
};

/** Deliberately small. Good enough for reading docs; not a browser. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl: string, inner: string) => `\n\n${'#'.repeat(Number(lvl))} ${strip(inner)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${strip(inner)}`)
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => `[${strip(inner)}](${href})`)
    .replace(/<(p|div|br|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const strip = (s: string): string => s.replace(/<[^>]+>/g, '').trim();
