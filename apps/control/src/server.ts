import { timingSafeEqual } from "node:crypto";
import { handleChatCompletions, createState } from "@eden/wrap";
import { minLlmReductionOf } from "@eden/ir";
import { handleApi, type ApiCtx } from "./api";
import type { Store } from "./store";

export type ServerOpts = {
  store: Store;
  token?: string;
  upstream?: string;
  upstreamKey?: string;
} & Pick<ApiCtx, "registry" | "island" | "sandboxFor">;

/**
 * Only a local page may talk to the control plane from a browser.
 *
 * This used to answer every preflight with `access-control-allow-origin: *`
 * and `allow-headers: authorization`. Because the credential is a bearer
 * header rather than a cookie, the wildcard is legal — and so any page on the
 * internet could read and drive the control plane on 127.0.0.1:8788, whose
 * /v1/wrap-run reaches the coding registry's Bash, Write and Edit executors.
 * A visited web page was one fetch away from running commands.
 */
/**
 * `handleApi` builds its responses without the request in hand, so all but one
 * of its ~39 exits carried `vary: origin` and no `access-control-allow-origin`.
 * A browser therefore got an affirmative preflight from the branch above and
 * then a CORS failure on the real response — the 401 was the only reply it
 * could actually read. Stamping the headers once, here at the boundary every
 * consumer shares, keeps that impossible to reintroduce a call site at a time.
 */
function withCors(res: Response, req: Request): Response {
  const cors = corsHeaders(req);
  try {
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  } catch {
    // A guarded (immutable) response cannot be mutated; rebuild it instead.
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return { vary: "origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "cache-control": "private, no-store",
    vary: "origin",
  };
}

function authorized(req: Request, token?: string): boolean {
  if (!token) return false;
  const m = /^Bearer\s+(.*)$/i.exec(req.headers.get("authorization") || "");
  if (!m) return false;
  const a = Buffer.from(m[1]!, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createHandler(opts: ServerOpts) {
  // Fail at construction rather than serving an API that authorises nobody and
  // reports 401 for everything, which reads as a broken install rather than a
  // misconfigured one.
  if (!opts.token) {
    throw new Error("eden control needs a token: pass --key, set EDEN_API_KEY, run eden login, or use --dev");
  }
  const wrapState = createState({ apiKey: opts.token });
  const ctx: ApiCtx = {
    store: opts.store,
    registry: opts.registry,
    island: opts.island,
    sandboxFor: opts.sandboxFor,
    wrapState,
    token: opts.token,
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    opts.store.heartbeat();
    wrapState.programs = opts.store.livePrograms();

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
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
      // Authenticated here because this branch runs before handleApi, which is
      // where the /v1/ gate lives. Unauthenticated, it was free inference on
      // the operator's upstream key for anyone who could reach the port — and
      // a text/plain POST is CORS-simple, so it needed no preflight to allow.
      if (!authorized(req, opts.token)) {
        return Response.json({ error: { message: "unauthorized" } }, { status: 401, headers: corsHeaders(req) });
      }
      return handleChatCompletions(req, {
        state: wrapState,
        upstream: opts.upstream,
        upstreamKey: opts.upstreamKey,
        getPrograms: () => opts.store.livePrograms(),
      });
    }
    const api = await handleApi(req, url, ctx);
    if (api) return withCors(api, req);
    return new Response("Not found", { status: 404, headers: corsHeaders(req) });
  };
}
