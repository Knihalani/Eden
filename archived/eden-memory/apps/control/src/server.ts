import { timingSafeEqual } from "node:crypto";
import { handleChatCompletions, createState } from "@eden/wrap";
import { handleAnthropicMessages } from "@eden/wrap";
import {
  minLlmReductionOf,
  protocolCheck,
  EDEN_PROTOCOL_VERSION,
  PROTOCOL_HEADER,
  isLoopbackHost,
  isLoopbackName,
  isLoopbackOrigin,
  looksBrowserDriven,
} from "@eden/ir";
import { handleApi, isManagedDeployment, playCompiled, type ApiCtx } from "./api";
import { scheduleClockEnabled, startScheduleClock } from "./schedule-clock";
import type { Store } from "./store";

export type ServerOpts = {
  store: Store;
  token?: string;
  upstream?: string;
  upstreamKey?: string;
  /** Minute clock for due schedules. Tests omit this. `EDEN_SCHEDULE_CLOCK=0` wins. */
  scheduleClock?: boolean | { intervalMs?: number };
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
  if (!isLoopbackOrigin(origin)) return { vary: "origin" };
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "cache-control": "private, no-store",
    vary: "origin",
  };
}

/**
 * CORS only stops a foreign page from reading replies. On a loopback bind the
 * page can still send: a CORS-simple POST, or anything at all once DNS
 * rebinding has made the port look same-origin. With the public `eden_dev`
 * key that reaches /v1/wrap-run and, through the coding registry, Bash. So a
 * loopback server refuses both before routing, as hookd does:
 * - a Host that is not a loopback name (rebinding; a browser always sends Host);
 * - a browser request whose Origin is not a page on this machine.
 * Non-browser clients (CLI, SDKs, curl) send no Origin and are unaffected.
 * A server bound elsewhere (a hosted deployment, a LAN bind) skips this check.
 */
function loopbackRefusal(req: Request, boundTo: string | undefined): Response | null {
  if (!isLoopbackName(boundTo)) return null;
  const host = req.headers.get("host");
  const foreignPage = looksBrowserDriven(req) && !isLoopbackOrigin(req.headers.get("origin") || "");
  if (host && isLoopbackHost(host) && !foreignPage) return null;
  return Response.json({ error: "forbidden: not a request from this machine" }, { status: 403 });
}

function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(.*)$/i.exec(req.headers.get("authorization") || "");
  return m ? m[1]! : null;
}

/** Timing-safe equality of two secrets; false when either is missing. */
function sameSecret(got: string | null | undefined, want: string | null | undefined): boolean {
  if (!got || !want) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req: Request, token?: string): boolean {
  return sameSecret(bearerToken(req), token);
}

/** Local two-line enable: agent keeps OPENAI_API_KEY and only changes BASE_URL. */
function isProviderKey(key: string): boolean {
  return key.startsWith("sk-") && key.length >= 12;
}

/**
 * Who may call the chat routes, whose model key pays (#84), and whether the caller is the
 * operator (#89). Null: nobody we know.
 * - The wrap token: the operator, who can read the local key. Wrap's own model key pays.
 * - A provider key (the two-line enable): the caller's own key is the upstream key. Wrap's
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY would let any local account spend the operator's key
 *   with a made-up `Bearer sk-…`.
 * A provider-key caller is the operator only if its key is the one wrap was started with
 * (`operatorKey`), or if it also sends the wrap token as x-eden-api-key. Any other caller gets
 * no memory and none of the operator's compiled tools: another local account could otherwise
 * read the operator's memory, write into it, and run its tools with a key of its own.
 */
function chatCaller(req: Request, token?: string, operatorKey?: string): { ownKey?: string; operator: boolean } | null {
  if (authorized(req, token)) return { operator: true };
  const allowProvider = isManagedDeployment() ? process.env.EDEN_DEV === "1" : process.env.EDEN_DEV !== "0";
  if (!allowProvider) return null;
  const got = bearerToken(req);
  if (!got || !isProviderKey(got)) return null;
  const edenKey = (req.headers.get("x-eden-api-key") || req.headers.get("x-eden-key") || "").trim();
  return { ownKey: got, operator: sameSecret(got, operatorKey?.trim()) || sameSecret(edenKey, token) };
}

export function createHandler(opts: ServerOpts) {
  // "eden_dev" is a public credential — it is in the source, the docs and
  // every laptop install. Middleware exempts /v1 from Clerk, so an embedded
  // handler built with the `EDEN_API_KEY || "eden_dev"` fallback on a managed
  // deployment would accept it from the public internet on the catch-all
  // route: full read of every workspace, plus writes on ungated routes. Same
  // managed/dev logic as apps/web's eden-key: on a managed install without a
  // real key, refuse the fallback (log once, then authorise nobody) instead
  // of presenting a credential anyone can guess.
  let token = opts.token;
  const refusedDevFallback = token === "eden_dev" && isManagedDeployment() && process.env.EDEN_DEV !== "1";
  if (refusedDevFallback) {
    console.error(
      "[eden] EDEN_API_KEY is not set on a managed install; refusing the public dev credential — set " +
        "EDEN_API_KEY (or EDEN_DEV=1 for a deliberate dev install)",
    );
    token = undefined;
  }
  // Fail at construction rather than serving an API that authorises nobody and
  // reports 401 for everything, which reads as a broken install rather than a
  // misconfigured one. (The refused-fallback case above deliberately does not
  // throw: a misconfigured deploy should answer 401, not crash-loop.)
  if (!opts.token) {
    throw new Error("eden control needs a token: pass --key, set EDEN_API_KEY, run eden login, or use --dev");
  }
  const wrapState = createState({ apiKey: token });
  // A chat caller that is not the operator gets this run state instead (#89). wrapState's usage
  // and model output are stamped onto the operator's next recorded trace, which compile reads.
  const guestState = createState({});
  const ctx: ApiCtx = {
    store: opts.store,
    registry: opts.registry,
    island: opts.island,
    sandboxFor: opts.sandboxFor,
    wrapState,
    // The scrubbed token, not opts.token: when the dev fallback was refused,
    // auth() must see "nothing is authorised" and 401 everything.
    token,
  };

  if (opts.scheduleClock && scheduleClockEnabled()) {
    const intervalMs = typeof opts.scheduleClock === "object" ? opts.scheduleClock.intervalMs : undefined;
    startScheduleClock(ctx, intervalMs != null ? { intervalMs } : undefined);
  }

  // Bun.serve passes the server as the second argument; in-process callers pass nothing.
  return async (req: Request, server?: { hostname?: string | undefined }): Promise<Response> => {
    const refused = loopbackRefusal(req, server?.hostname);
    if (refused) return refused;
    const url = new URL(req.url);
    opts.store.heartbeat();
    wrapState.programs = opts.store.livePrograms();

    // Protocol gate: refuse a client whose wire version mismatches ours with
    // an explanation, instead of letting shape skew fail obscurely downstream.
    if (url.pathname.startsWith("/v1/")) {
      const gate = protocolCheck(req.headers.get(PROTOCOL_HEADER));
      if (!gate.ok) {
        return Response.json(
          { error: gate.reason },
          {
            status: gate.status,
            headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION), ...corsHeaders(req) },
          },
        );
      }
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "eden-wrap",
        protocol: EDEN_PROTOCOL_VERSION,
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
      const caller = chatCaller(req, token, opts.upstreamKey || process.env.OPENAI_API_KEY);
      if (!caller) {
        return Response.json({ error: { message: "unauthorized" } }, { status: 401, headers: corsHeaders(req) });
      }
      return handleChatCompletions(req, {
        state: caller.operator ? wrapState : guestState,
        upstream: opts.upstream,
        // Non-empty for a provider key, so the OPENAI_API_KEY fallback is never reached.
        upstreamKey: caller.ownKey ?? opts.upstreamKey,
        memory: caller.operator,
        getPrograms: () => (caller.operator ? opts.store.livePrograms() : []),
        play: caller.operator ? (name, args) => playCompiled(ctx, name, args) : undefined,
      });
    }
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      // Anthropic Messages API dialect (G7): same auth gate as chat/completions.
      const caller = chatCaller(req, token, process.env.ANTHROPIC_API_KEY);
      if (!caller) {
        return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
      }
      return handleAnthropicMessages(req, {
        state: caller.operator ? wrapState : guestState,
        getPrograms: () => (caller.operator ? opts.store.livePrograms() : []),
        upstreamKey: caller.ownKey,
        memory: caller.operator,
      });
    }
    const api = await handleApi(req, url, ctx);
    if (api) return withCors(api, req);
    if (url.pathname.startsWith("/v1/") || url.pathname === "/v1") {
      return Response.json(
        { error: "not found" },
        { status: 404, headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION), ...corsHeaders(req) } },
      );
    }
    return new Response("Not found", { status: 404, headers: corsHeaders(req) });
  };
}
