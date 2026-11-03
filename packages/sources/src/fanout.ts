import type { ContextItem } from "@eden/protocol";
import type { SearchQuery, Source } from "./source";

export interface SourceOutcome {
  sourceId: string;
  status: "ok" | "error" | "timeout";
  items: ContextItem[];
  latencyMs: number;
  error?: string;
}

/**
 * Searches several sources at once. Never throws: a source that errors or misses its deadline contributes nothing
 * and reports why, so one slow connector cannot hold up or break a delivery. `signal` is the caller's deadline: once
 * it aborts (or `timeoutMs` passes) a source still running reports "timeout" with no items, and a signal already
 * aborted on entry calls no source at all.
 */
export async function searchSources(
  sources: Source[],
  query: SearchQuery,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<SourceOutcome[]> {
  return Promise.all(
    sources.map(async (source): Promise<SourceOutcome> => {
      const t0 = performance.now();
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const elapsed = () => Math.round(performance.now() - t0);
      const timedOut = (): SourceOutcome => ({
        sourceId: source.id,
        status: "timeout",
        items: [],
        latencyMs: elapsed(),
        error: "timeout",
      });
      // An abort event fires once: a listener added after it would wait forever on a source that ignores its signal.
      if (signal.aborted) return timedOut();
      try {
        const items = await Promise.race([
          source.search(query, signal),
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
          }),
        ]);
        // A source that ignores its signal can resolve after the deadline: late items are not this search's.
        if (signal.aborted) return timedOut();
        return { sourceId: source.id, status: "ok", items, latencyMs: elapsed() };
      } catch (e) {
        if (signal.aborted) return timedOut();
        return { sourceId: source.id, status: "error", items: [], latencyMs: elapsed(), error: String(e) };
      }
    }),
  );
}
