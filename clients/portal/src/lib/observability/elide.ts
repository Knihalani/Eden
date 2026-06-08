/**
 * Elide framework-internal spans from the trace tree.
 *
 * Phase 7.2 (C2): framework auto-instrumentation packages emit
 * hundreds of internal HTTP / queue / framework spans per call
 * (httpx, urllib3, asyncio, openai, langchain, langgraph, etc.).
 * The transcript view collapses them into a single "Show N internal
 * spans" toggle so the user sees the agent's actual work — not the
 * transport plumbing.
 *
 * The prefix set is intentionally permissive; a span that doesn't
 * match any prefix is kept (so we don't accidentally hide real work).
 */

const INTERNAL_FRAMEWORK_SPAN_PREFIXES = [
  "openai._",
  "openai._client",
  "openai._utils",
  "openai._streaming",
  "httpx.",
  "httpcore.",
  "urllib3.",
  "urllib.",
  "asyncio.",
  "anyio.",
  "langchain._",
  "langchain.chat_models.",
  "langchain.llms.",
  "langchain.embeddings.",
  "langchain.vectorstores.",
  "langchain.document_loaders.",
  "langchain.text_splitter",
  "langgraph.",
  "langgraph.pregel.",
  "langgraph.checkpoint.",
  "llama_index.",
  "pydantic.",
  "pydantic_ai.",
  "json.tool",
  "json.encoder",
  "json.decoder",
  "logging.",
  "asyncio.events",
  "selectors.",
  "socket.",
  "ssl.",
  "http.",
];

export function isInternalFrameworkSpan(name: string | undefined | null): boolean {
  if (!name) return false;
  return INTERNAL_FRAMEWORK_SPAN_PREFIXES.some((p) => name.startsWith(p));
}

export function elideInternalSpans<T extends { name?: string; event_type?: string; children?: T[] }>(
  spans: T[],
): T[] {
  return spans.filter((s) => !isInternalFrameworkSpan(s.name));
}
