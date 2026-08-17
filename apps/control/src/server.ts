import { handleChatCompletions } from "@eden/wrap";
import { handleApi, type ApiCtx } from "./api";
import type { Store } from "./store";
import { createState } from "@eden/wrap";
import { minLlmReductionOf } from "@eden/ir";

export type ServerOpts = {
  store: Store;
  token?: string;
  upstream?: string;
  upstreamKey?: string;
} & Pick<ApiCtx, "registry" | "island">;

export function createHandler(opts: ServerOpts) {
  const wrapState = createState({ apiKey: opts.token });
  const ctx: ApiCtx = {
    store: opts.store,
    registry: opts.registry,
    island: opts.island,
    token: opts.token || "eden_dev",
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    opts.store.heartbeat();
    wrapState.programs = opts.store.livePrograms();

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        },
      });
    }
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "eden-wrap",
        traces: opts.store.tracesCount(),
        live: opts.store.liveCount(),
        candidates: opts.store.candidatesCount(),
        receipts: opts.store.receiptsCount(),
        fails: opts.store.failsCount(),
        savings: opts.store.savings(),
        minLlmReduction: minLlmReductionOf(Number(process.env.EDEN_MIN_LLM_REDUCTION)),
        registry: Boolean(opts.registry),
        island: Boolean(opts.island),
      });
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      return handleChatCompletions(req, {
        state: wrapState,
        upstream: opts.upstream,
        upstreamKey: opts.upstreamKey,
        getPrograms: () => opts.store.livePrograms(),
      });
    }
    const api = await handleApi(req, url, ctx);
    if (api) return api;
    return new Response("Not found", { status: 404 });
  };
}
