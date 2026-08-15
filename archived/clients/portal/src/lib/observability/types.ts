/**
 * Transcript types — shared shape for TranscriptView, MessageBlock,
 * ToolCallBlock, ImageBlock, ReasoningBlock. The transcript renders
 * a trace chronologically as a conversation: each LLM call, tool
 * call, tool result, and subagent gets its own block.
 */

export interface TranscriptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface TranscriptToolCall {
  id?: string;
  type: "function" | "tool_use";
  name: string;
  arguments?: unknown;
}

export interface TranscriptToolResult {
  tool_call_id?: string;
  content: unknown;
  is_error?: boolean;
  name?: string;
}

export interface TranscriptReasoningBlock {
  text?: string;
  signature?: string;
  data?: string;  // redacted_thinking blob
  thought?: boolean;  // Gemini thought
}

export interface TranscriptImageBlock {
  content_type?: string;
  url?: string;  // signed URL or local ref
  data_b64?: string;  // inline (small images only)
  source?: string;  // "openai_input" | "anthropic_input" | etc.
}

export interface TranscriptLogprobsEntry {
  token: string;
  logprob: number;
  bytes?: number[];
}

export interface TranscriptCitation {
  url?: string;
  title?: string;
  cited_text?: string;
  start_index?: number;
  end_index?: number;
}

export interface TranscriptRow {
  span_id: string;
  parent_span_id?: string | null;
  agent_id?: string | null;
  name: string;
  event_type?: string;
  timestamp: string;
  duration_ms: number;
  outcome?: string | null;
  /** Token / cost from getTraceTree metrics (or child rollup). */
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** USD cost when present on span metrics/payload/attributes. */
  cost_usd?: number | null;
  // ── Provider-specific extensions ──
  request_body?: {
    model?: string;
    messages?: TranscriptMessage[];
    system?: string | unknown[];
    temperature?: number;
    max_tokens?: number;
    tools?: unknown[];
    stream?: boolean;
  } | null;
  response_body?: unknown;
  reasoning?: TranscriptReasoningBlock[] | null;
  tool_calls?: TranscriptToolCall[] | null;
  tool_results?: TranscriptToolResult[] | null;
  images?: TranscriptImageBlock[] | null;
  logprobs?: { content?: TranscriptLogprobsEntry[] } | null;
  citations?: TranscriptCitation[] | null;
  finish_reason?: string | null;
  stop_sequence?: string | null;
  system_fingerprint?: string | null;
  cache_hit?: boolean;
  model_version?: string | null;
  service_tier?: string | null;
  streaming_metrics?: {
    ttft_ms?: number | null;
    itl_ms_avg?: number | null;
    tpot_ms?: number | null;
  } | null;
  // ── Subagent nesting ──
  is_subagent?: boolean;
  children?: TranscriptRow[];
}
