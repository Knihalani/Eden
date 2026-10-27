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
 * and reports why, so one slow connector cannot hold up or break a delivery.
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
      try {
        const items = await Promise.race([
          source.search(query, signal),
          new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
          }),
        ]);
        return { sourceId: source.id, status: "ok", items, latencyMs: elapsed() };
      } catch (e) {
        const status = timeout.aborted ? "timeout" : "error";
        return { sourceId: source.id, status, items: [], latencyMs: elapsed(), error: String(e) };
      }
    }),
  );
}
