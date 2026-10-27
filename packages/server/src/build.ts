import { ContextPartner, ItemCache, type TraceSink } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, OpenRouterModel, type Model } from "@eden/llm";
import type { SourceResolver } from "@eden/sources";

export interface BuildOptions {
  sources: SourceResolver;
  sourceMapPath?: string;
  model?: Model | null;
  onTrace?: TraceSink;
}

/** Wires a partner from its parts with production defaults. */
export function buildPartner(options: BuildOptions): ContextPartner {
  return new ContextPartner({
    sources: options.sources,
    sourceMap: new SourceMap(options.sourceMapPath),
    cache: new ItemCache(),
    budget: new Budget(),
    model: options.model === undefined ? OpenRouterModel.fromEnv() : options.model,
    onTrace: options.onTrace,
  });
}
