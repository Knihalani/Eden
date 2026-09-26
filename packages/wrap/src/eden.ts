import { createState, wrapTools, type WrapState } from "./wrap-tools";
import type { EdenOpts, ToolsIn } from "./types";
import { wrapIsland } from "./island";

export type OpenAiHandle = {
  model: string;
  baseURL: string;
  apiKey: string;
};

export function eden(opts: EdenOpts = {}) {
  const state: WrapState = createState({
    ...opts,
    island: opts.island ?? (process.env.OPENAI_API_KEY || opts.apiKey ? wrapIsland({ apiKey: opts.apiKey, fetch: opts.fetch }) : undefined),
  });
  const proxy = process.env.EDEN_WRAP_URL || "http://127.0.0.1:8788/v1";
  return {
    state,
    wrapTools: <T extends ToolsIn>(tools: T) => wrapTools(tools, state),
    openai: (model: string): OpenAiHandle => {
      const apiKey =
        process.env.OPENAI_API_KEY || opts.apiKey || (process.env.EDEN_DEV === "1" ? "eden_dev" : "");
      return {
        model,
        baseURL: proxy,
        apiKey,
        async resolve() {
          const ok = await fetch(`${proxy.replace(/\/v1\/?$/, "").replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
          if (ok) return { model, baseURL: proxy, apiKey };
          return { model, baseURL: "https://api.openai.com/v1", apiKey };
        },
      } as OpenAiHandle & { resolve: () => Promise<OpenAiHandle> };
    },
    setPrograms: (programs: WrapState["programs"]) => {
      state.programs = programs;
    },
  };
}
