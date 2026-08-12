/**
 * Canonical internal representation.
 *
 * Everything the engine handles is expressed in these types. Protocol adapters
 * translate between these and the wire formats (OpenAI / Anthropic). Nothing
 * outside `protocol/` should know what a provider's JSON looks like.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  /** base64-encoded bytes, no data: prefix */
  data: string;
  mediaType: string;
  /** Some providers accept URLs; Ollama does not (quirk: imageInput). */
  url?: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  /** Rendered result text handed back to the model. */
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  id: string;
  role: Role;
  content: ContentBlock[];
  /**
   * Chain-of-thought text as returned by the provider.
   *
   * MUST be preserved verbatim. DeepSeek returns 400 on multi-turn requests
   * with tool calls if `reasoning_content` is not echoed back. Middle layers
   * that "clean up" the history by dropping this field are the single most
   * common source of breakage in aggregator clients.
   */
  reasoningContent?: string;
  /** Opaque per-provider signature for reasoning blocks (Anthropic-style). */
  reasoningSignature?: string;
  modelId?: string;
  createdAt: number;
  /** F6.1: pinned messages survive context compaction. */
  pinned?: boolean;
  /** F6.1: excluded messages are kept locally but not sent to the model. */
  excluded?: boolean;
  /** Set on summary messages produced by compaction. */
  compressedFrom?: string[];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: RiskLevel;
  /** Tools that mutate the filesystem get snapshotted before running. */
  mutatesFilesystem?: boolean;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface ModelRequest {
  modelId: string;
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  thinking?: ThinkingLevel;
  /** Opt out of streaming; adapters fall back automatically when needed. */
  stream?: boolean;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Usage & cost
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export type Currency = 'CNY' | 'USD';

export interface CostBreakdown {
  /** Cost in the provider's own billing currency. */
  amountOriginal: number;
  currency: Currency;
  /** FX rate frozen at call time — never recompute historical cost. */
  fxRate: number;
  fxSource: string;
  fxFetchedAt: number;
  amountCny: number;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'aborted'
  | 'error';

export interface ModelResponse {
  message: Message;
  usage: Usage;
  stopReason: StopReason;
  latencyMs: number;
  ttftMs?: number;
  /** Which provider/key actually served the request after routing/failover. */
  servedBy: { providerId: string; modelId: string; credentialLabel?: string };
}
