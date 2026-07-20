/**
 * Map SDK sourceFormat labels onto backend ingest path segments.
 *
 * Backend allow-list:
 *   otel | helicone | langfuse | openai | anthropic | bedrock |
 *   gemini | framework | webhook
 *
 * TraceEvent-shaped SDK payloads are accepted by the webhook decoder.
 * The framework decoder expects OTel resourceSpans, so framework aliases
 * also remap to webhook.
 */

export const ALLOWED_INGEST_FORMATS = new Set([
  "otel",
  "helicone",
  "langfuse",
  "openai",
  "anthropic",
  "bedrock",
  "gemini",
  "framework",
  "webhook",
]);

const INGEST_FORMAT_REMAP: Record<string, string> = {
  custom: "webhook",
  "eden-sdk-doctor": "webhook",
  "eden-sdk-logging": "webhook",
  eden_sdk: "webhook",
  "eden-trace-agent-ts": "webhook",
  "eden-auto-instrument-ts": "webhook",
  "eden-auto-instrument": "webhook",
  "vercel-ai": "webhook",
  langchain: "webhook",
  llama_index: "webhook",
  "llama-index": "webhook",
  "pydantic-ai": "webhook",
  pydantic_ai: "webhook",
  mastra: "webhook",
  crewai: "webhook",
  autogen: "webhook",
  smolagents: "webhook",
};

/** Return the `/ingest/{format}` path segment for a sourceFormat label. */
export function resolveIngestPath(sourceFormat: string): string {
  const fmt = (sourceFormat || "").trim().toLowerCase() || "webhook";
  if (ALLOWED_INGEST_FORMATS.has(fmt)) return fmt;
  return INGEST_FORMAT_REMAP[fmt] ?? "webhook";
}
