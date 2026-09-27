import type { IslandCaller } from "@eden/ir";

export const PROVIDER_BATCH_CENTS = 0.5;

export type IslandBatchOpts = {
  fetch?: typeof fetch;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  coalesceMs?: number;
};

export function islandBatchUrl(baseURL?: string | null): string {
  const base = (baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
  return `${base}/messages/batches`;
}

export function canUseProviderBatch(opts: IslandBatchOpts = {}): boolean {
  if (opts.fetch) return true;
  const base = (opts.baseURL || "").replace(/\/$/, "") || "https://api.openai.com/v1";
  return !/api\.openai\.com/i.test(base) && !/api\.anthropic\.com/i.test(base);
}

export function withIslandBatch(base: IslandCaller, _opts: IslandBatchOpts = {}): IslandCaller {
  return (req) => base((({ wait: _wait, ...rest }) => rest)(req));
}
