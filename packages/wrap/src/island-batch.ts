import type { IslandCaller } from "@eden/ir";

export type IslandBatchOpts = {
  fetch?: typeof fetch;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  coalesceMs?: number;
};

export function withIslandBatch(base: IslandCaller, _opts: IslandBatchOpts = {}): IslandCaller {
  return (req) => base((({ wait: _wait, ...rest }) => rest)(req));
}
