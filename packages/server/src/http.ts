/**
 * The HTTP API an agent integration calls. All routes take and return JSON.
 *
 *   POST /v1/events    an AgentEvent              → ObserveResult  (?waitMs= to wait for the slow path)
 *   POST /v1/ask       an AskRequest              → AskResponse
 *   POST /v1/check     a tool_call AgentEvent     → ActionCheck   (the party check, D376)
 *   POST /v1/pending   {tenantId,userId,sessionId} → {injections}
 *   POST /v1/whoami    {tenantId,userId,sessionId?} → {ok}  (checks the key, tenant and ids; changes nothing)
 *   POST /v1/explain   {tenantId,userId,sessionId} → {decisions}: the session's last decisions and why, no content
 *                                                    (D277; reads only)
 *   POST /v1/feedback  a Feedback (used: boolean)  → {ok, applied}
 *   POST /v1/forget    {tenantId,userId,sourceId?} → {ok}  (also closes the user's source connections, D108)
 *   POST /v1/sources   {tenantId,userId}           → {sources:[{id,kind}]}; 422 {error} when the user's source
 *                                                    configuration is broken (only with per-user sources, D108)
 *   POST /v1/sources/changed {tenantId,userId,sourceId} → {ok, synced}: a change notification (`syncPush`)
 *   POST /v1/sources/items   {tenantId,userId,sourceId,items:[{ref,title?,text,url?,updatedAt?,meta?}]}
 *                                                    → {ok, stored}: the items a notification carried (`syncPush`)
 *   POST /v1/sources/removed {tenantId,userId,sourceId,refs:[…]} → {ok, removed}: refs the source deleted (`syncPush`)
 *   POST /v1/sources/refs    {tenantId,userId,sourceId,refs:[…]} → {ok, synced, reason?}: refs the source changed or
 *                            added, read by Eden in the background (`syncPush`, D347)
 *   POST /v1/usage     {tenantId}                  → the tenant's usage today (D326): modelUsd, modelCalls, capUsd,
 *                                                    requests by route, users (frozenUsers, syncedUsers), items; the
 *                                                    router sums its children's; `integration`: how the tenant's
 *                                                    integration calls Eden since the process started (D852,
 *                                                    `eden doctor`), counts only
 *   GET  /healthz
 *
 * Auth: `Authorization: Bearer <key>`; the key fixes the tenant, and a body naming another tenant is refused.
 * Each tenant is rate limited (GCRA, `ServerConfig.tenantRatePerSec` / `tenantBurst`): past it, 429 with Retry-After,
 * so one tenant cannot starve the others.
 * Bodies are capped (`ServerConfig.maxBodyBytes`, 8 MB by default, D100): a declared content-length past it is a 413
 * before the body is read; `main.ts` passes the same cap to Bun.serve, which also covers bodies sent without one.
 * Errors are `{error}` with a 4xx for the caller's mistakes; nothing the caller sends can produce a 500.
 */
import { explainTrace, type ContextPartner } from "@eden/engine";
import { Gcra } from "@eden/primitives";
import {
  bodyShapeUnder,
  checkAsk,
  checkEvent,
  checkSourceChanged,
  checkSourceItems,
  checkSourceRefs,
  checkSourceRemoved,
  isId,
  keylessOriginAllowed,
} from "@eden/protocol";
import type { TenantSpend } from "@eden/llm";
import { DEFAULT_MAX_BODY_BYTES, FANOUT_COPY, type ServerConfig } from "./config";
import { keyOf } from "./auth";
import { IntegrationStats } from "./integration-stats";
import type { UserSources } from "./user-sources";

type Json = Record<string, unknown>;
const decoder = new TextDecoder();
const ROUTES = new Set(
  [
    "events",
    "check",
    "ask",
    "pending",
    "whoami",
    "explain",
    "feedback",
    "usage",
    "forget",
    "sources/changed",
    "sources/items",
    "sources/refs",
    "sources/removed",
    "sources",
  ].map((r) => `/v1/${r}`),
);
/** The authority `pathOf` last confirmed: one a server sees on every request, so it is checked once. */
let plainAuthority = "";

/**
 * A request URL's path, as `new URL(url).pathname` gives it, and throwing where it throws (D1892). An http(s) URL whose
 * path holds only letters, digits, `/`, `_` and `-` (nothing `new URL` rewrites: no dot segment, escape, backslash or
 * white space) is sliced; its authority is checked by `new URL` itself, once per distinct authority. Anything else
 * is parsed. `path-of.test.ts` fuzzes it against `new URL`.
 */
export function pathOf(url: string): string {
  const s = url.startsWith("http://") ? 7 : url.startsWith("https://") ? 8 : -1;
  const p = s < 0 ? -1 : url.indexOf("/", s);
  if (p < 0) return new URL(url).pathname;
  let i = p;
  for (; i < url.length; i++) {
    const c = url.charCodeAt(i);
    if (c === 63 || c === 35) break; // ? and #: the path ends
    const plain = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 47 && c <= 57) || c === 95 || c === 45;
    if (!plain) return new URL(url).pathname;
  }
  const authority = url.slice(0, p);
  if (authority !== plainAuthority) {
    // The authority must end where the slice says (no `\`, `?`, `#` or white space moving the path) and parse.
    if (new URL(`${authority}/x`).pathname !== "/x") return new URL(url).pathname;
    plainAuthority = authority;
  }
  return url.slice(p, i);
}

/**
 * A request URL's query, as `new URL(url).searchParams` reads it (D1892): the text after the first `?` up to a `#`,
 * parsed by URLSearchParams directly when it holds nothing the URL parser strips or rewrites first (white space,
 * control characters, a backslash); otherwise the whole URL is parsed. None when there is no `?`.
 */
export function queryOf(url: string): URLSearchParams {
  const q = url.indexOf("?");
  const f = url.indexOf("#");
  if (q < 0 || (f >= 0 && f < q)) return new URLSearchParams();
  const h = url.indexOf("#", q);
  const query = h < 0 ? url.slice(q + 1) : url.slice(q + 1, h);
  for (let i = 0; i < query.length; i++) if (query.charCodeAt(i) <= 0x20) return new URL(url).searchParams;
  // URLSearchParams drops one leading "?" of a string it is given; the URL's own query keeps it.
  return new URLSearchParams(query.charCodeAt(0) === 63 ? `?${query}` : query);
}

/** The UTC day (YYYY-MM-DD) last formatted, and the milliseconds it covers: one toISOString a day, not a request. */
let dayText = "";
let dayFrom = 0;
let dayTo = 0;
export function utcDay(now: number): string {
  // Years 0-9999 only (`toISOString`'s plain form); anything else (and NaN, which throws) is formatted each time.
  if (!(now >= 0 && now < 253_402_300_800_000)) return new Date(now).toISOString().slice(0, 10);
  if (now < dayFrom || now >= dayTo || !dayText) {
    dayText = new Date(now).toISOString().slice(0, 10);
    dayFrom = Date.UTC(+dayText.slice(0, 4), +dayText.slice(5, 7) - 1, +dayText.slice(8, 10));
    dayTo = dayFrom + 86_400_000;
  }
  return dayText;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

export function createHandler(
  partner: ContextPartner,
  config: Pick<ServerConfig, "keys" | "dev"> &
    Partial<Pick<ServerConfig, "tenantRatePerSec" | "tenantBurst" | "maxBodyBytes" | "child">>,
  /** Per-user sources (D108): forget closes the user's connections, and `/v1/sources` reports their config. */
  userSources?: UserSources,
  /** The tenant spend cap the partner's model roles share, for `/v1/usage` (D326); omitted, spend reads 0. */
  spend?: TenantSpend,
  /** How the tenant's integration calls Eden (D852), for `eden doctor`; returned by `/v1/usage` as `integration`. */
  stats: IntegrationStats = new IntegrationStats(),
) {
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const tooLarge = `body must be at most ${maxBodyBytes.toLocaleString("en-US")} bytes`;
  const limiter = new Gcra({ ratePerSec: config.tenantRatePerSec ?? 200, burst: config.tenantBurst ?? 400 });
  const tenantOf = (req: Request): string | null => {
    const key = keyOf(req);
    if (key && config.keys.has(key)) return config.keys.get(key)!;
    // Dev mode accepts a missing key, never a wrong one: a typo'd production key must not land in tenant "dev".
    return config.dev && !key ? "dev" : null;
  };
  /** A keyless (dev) request from a browser page on another site (audit A20: `keylessOriginAllowed`). */
  const foreignPage = (req: Request, tenant: string) =>
    tenant === "dev" && !keyOf(req) && !keylessOriginAllowed(req.headers.get("origin"));
  const badId = (body: Json, fields: string[]) => fields.find((f) => !isId(body[f]));
  // Requests per tenant and UTC day, by route (D326's usage report): counts only, today's alone (yesterday's dropped at
  // the first request of a new day), one small record per tenant.
  let countedDay = "";
  const counted = new Map<string, Record<string, number>>();
  const count = (tenant: string, route: string) => {
    const day = utcDay(Date.now());
    if (day !== countedDay) {
      counted.clear();
      countedDay = day;
    }
    let c = counted.get(tenant);
    if (!c) counted.set(tenant, (c = {}));
    c[route] = (c[route] ?? 0) + 1;
  };

  return async function handle(req: Request): Promise<Response> {
    const path = pathOf(req.url);
    if (req.method === "GET" && path === "/healthz") return json({ ok: true });
    // A path the API does not have is 404 whatever the method (R1); one of its routes asked with GET is 405.
    if (req.method !== "POST") return ROUTES.has(path) ? fail(405, "method not allowed") : fail(404, "not found");
    const tenant = tenantOf(req);
    if (!tenant) return fail(401, "missing or unknown API key");
    if (foreignPage(req, tenant)) return fail(403, "dev mode serves no key-less request from another site's page");
    // A router's fan-out copy (forget, usage) to a child that does not own the user: the owner's copy spends the
    // tenant's token and is counted; the copies do neither, or a usage read would spend N tokens and a limited child
    // would read as down (A24). Honoured only in a router child and on the routes the router copies: in a single
    // process, or on any other route, the header means nothing.
    const copy =
      config.child != null && (path === "/v1/forget" || path === "/v1/usage") && req.headers.get(FANOUT_COPY) === "1";
    const waitMs = copy ? 0 : limiter.take(tenant);
    if (waitMs > 0) {
      return Response.json(
        { error: "rate limited" },
        { status: 429, headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) } },
      );
    }
    // After auth and the limiter, so their answers are unchanged; before req.json(), so an oversized body is never
    // buffered or parsed on the loop. A missing or unparseable header falls through to Bun.serve's cap (main.ts).
    const declared = Number(req.headers.get("content-length") ?? NaN);
    if (declared > maxBodyBytes) return fail(413, tooLarge);
    let body: Json;
    let chars: number;
    try {
      const bytes = await req.bytes();
      // Before the parse, which is where a padded body's cost lies (D100's cap bounds bytes, not values or depth).
      if (!bodyShapeUnder(bytes)) return fail(400, "body holds too many values or nests too deep");
      const text = decoder.decode(bytes);
      chars = text.length; // `checkEvent`'s bound on a tool call input's JSON (D1940)
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "body must be an object");
      body = parsed as Json;
    } catch {
      return fail(400, "body must be JSON");
    }
    body.tenantId ??= tenant;
    if (body.tenantId !== tenant) return fail(403, "tenantId does not match the API key");

    // Known routes only (a bounded record), and not a router's fan-out copy (counted once, by the owning child).
    if (ROUTES.has(path) && !copy) count(tenant, path.slice(4));
    try {
      const answer = await route(path, req.url, body, tenant, chars);
      if (answer.status === 400) stats.refused(tenant);
      return answer;
    } catch (e) {
      console.error("eden: request failed", path, e instanceof Error ? e.message : e);
      return fail(503, "temporarily unable to serve context"); // An integration treats this as silence.
    }
  };

  async function route(path: string, url: string, body: Json, tenant: string, chars: number): Promise<Response> {
    switch (path) {
      case "/v1/events": {
        const checked = checkEvent(body, chars);
        if (!checked.ok) return fail(400, checked.error);
        const query = queryOf(url);
        const waitMs = Math.max(0, Math.min(5_000, Number(query.get("waitMs") ?? 0) || 0));
        // `?shadow=1`: an integration trying Eden without injecting (the proxy's shadow mode): nothing is learned.
        const shadow = query.get("shadow") === "1";
        const observed = await partner.observe(checked.value, { waitMs, ...(shadow ? { shadow } : {}) });
        stats.event(tenant, checked.value, waitMs, observed.pending === true, shadow);
        return json(observed);
      }
      case "/v1/check": {
        // The party check (D376): a tool call the agent is about to make, checked before it runs (no model).
        const checked = checkEvent(body, chars);
        if (!checked.ok) return fail(400, checked.error);
        if (checked.value.kind !== "tool_call") return fail(400, "check takes a tool_call event");
        stats.check(tenant, checked.value.tool);
        return json(await partner.checkAction(checked.value));
      }
      case "/v1/ask": {
        const checked = checkAsk(body);
        if (!checked.ok) return fail(400, checked.error);
        stats.ask(tenant, checked.value.userId, checked.value.sessionId);
        return json(await partner.ask(checked.value));
      }
      case "/v1/pending": {
        const bad = badId(body, ["userId", "sessionId"]);
        if (bad) return fail(400, `${bad} must be 1-128 characters of [A-Za-z0-9._:@-]`);
        const who = { tenantId: tenant, userId: body.userId as string, sessionId: body.sessionId as string };
        const shadow = queryOf(url).get("shadow") === "1";
        stats.pending(tenant, who.userId, who.sessionId, shadow);
        // D325: the take checks new items against the session's plans (`checkPlans`), which reads the user's items.
        await partner.ready(who);
        return json({ injections: partner.takePending(who, shadow ? { shadow } : {}) });
      }
      case "/v1/whoami": {
        // The client's `health()`: the key, the tenant and the ids are checked as any route checks them, and nothing
        // is read or changed (unlike `/v1/pending`, which drains the queue).
        const bad = badId(body, ["userId"]);
        if (bad) return fail(400, `${bad} must be 1-128 characters of [A-Za-z0-9._:@-]`);
        if (body.sessionId !== undefined && !isId(body.sessionId)) {
          return fail(400, "sessionId must be 1-128 characters of [A-Za-z0-9._:@-]");
        }
        return json({ ok: true });
      }
      case "/v1/explain": {
        // Why Eden spoke or stayed silent in this session (D277): its traces, content-free (D56), a sentence each.
        const bad = badId(body, ["userId", "sessionId"]);
        if (bad) return fail(400, `${bad} must be 1-128 characters of [A-Za-z0-9._:@-]`);
        const who = { tenantId: tenant, userId: body.userId as string, sessionId: body.sessionId as string };
        const decisions = partner.explain(who).map((t) => ({
          turn: t.turn,
          event: t.event,
          decision: t.decision,
          reason: t.reason,
          why: explainTrace(t),
          latencyMs: t.latencyMs,
          sourceCalls: t.sourceCalls,
          modelCalls: t.modelCalls,
          costUsd: t.costUsd,
          itemIds: t.itemIds,
        }));
        return json({ decisions });
      }
      case "/v1/feedback": {
        const bad = badId(body, ["userId", "sessionId", "injectionId"]);
        if (bad) return fail(400, `${bad} must be 1-128 characters of [A-Za-z0-9._:@-]`);
        if (typeof body.used !== "boolean") return fail(400, "used must be true or false");
        stats.feedback(tenant);
        // D325: the verdict may sit in a frozen blob (D1998), so thaw before `feedback` reads `recorded`.
        await partner.ready({ tenantId: tenant, userId: body.userId as string });
        const applied = partner.feedback({
          tenantId: tenant,
          userId: body.userId as string,
          sessionId: body.sessionId as string,
          injectionId: body.injectionId as string,
          used: body.used,
          how: "explicit",
        });
        return json({ ok: true, applied });
      }
      case "/v1/usage": {
        // The tenant's own usage today in this process (D326): model spend and calls against the cap this process
        // holds, requests by route, users held. The router sums its children's (router.ts); counts only.
        const day = utcDay(Date.now());
        return json({
          tenantId: tenant,
          day,
          processes: 1,
          modelUsd: spend?.spent(tenant) ?? 0,
          modelCalls: spend?.calls(tenant) ?? 0,
          capUsd: spend?.capOf(tenant) ?? 0,
          requests: day === countedDay ? { ...counted.get(tenant) } : {},
          ...partner.tenantUsage(tenant),
          // Since the process started, not today (D852): what `eden doctor` reads.
          integration: stats.of(tenant),
        });
      }
      case "/v1/forget": {
        if (badId(body, ["userId"])) return fail(400, "userId must be 1-128 characters of [A-Za-z0-9._:@-]");
        if (body.sourceId !== undefined && !isId(body.sourceId)) return fail(400, "sourceId is malformed");
        const scope = { tenantId: tenant, userId: body.userId as string };
        // D325: one source's forget drops its items from the user's cache, a read; the whole user's forget reads
        // nothing (a frozen user's record is simply dropped).
        if (body.sourceId !== undefined) await partner.ready(scope);
        partner.forget(scope, body.sourceId as string | undefined);
        userSources?.forget(scope, body.sourceId as string | undefined);
        return json({ ok: true });
      }
      case "/v1/sources/changed": {
        // A webhook or watch the integrator receives, forwarded: the source's synced copy is polled at its next use.
        const checked = checkSourceChanged(body);
        if (!checked.ok) return fail(400, checked.error);
        const { userId, sourceId } = checked.value;
        stats.notice(tenant, "signals");
        // 200 either way (a no-op notification is not a caller error); `reason` says why nothing was synced.
        return json({ ok: true, ...partner.sourceNotice({ tenantId: tenant, userId }, sourceId) });
      }
      case "/v1/sources/items": {
        // The changed items themselves (a Slack event, a trigger's payload): held as synced, with no source call.
        const checked = checkSourceItems(body);
        if (!checked.ok) return fail(400, checked.error);
        const { userId, sourceId, items } = checked.value;
        stats.notice(tenant, "items");
        return json({ ok: true, stored: await partner.sourceItems({ tenantId: tenant, userId }, sourceId, items) });
      }
      case "/v1/sources/refs": {
        // What changed, named but not carried (a Gmail history's ids, a webhook's resource id): Eden reads those
        // refs itself in the background (D347). 200 at once; `reason` when it acts as a plain signal could not.
        const checked = checkSourceRefs(body);
        if (!checked.ok) return fail(400, checked.error);
        const { userId, sourceId, refs } = checked.value;
        stats.notice(tenant, "refs");
        const { settled, ...result } = partner.sourceRefs({ tenantId: tenant, userId }, sourceId, refs);
        void settled.catch(() => 0);
        return json({ ok: true, ...result });
      }
      case "/v1/sources/removed": {
        // A deletion the integrator was told of (a recalled message, a deleted doc or event): dropped at once.
        const checked = checkSourceRemoved(body);
        if (!checked.ok) return fail(400, checked.error);
        const { userId, sourceId, refs } = checked.value;
        stats.notice(tenant, "removed");
        await partner.ready({ tenantId: tenant, userId }); // D325, as above.
        return json({ ok: true, removed: partner.sourceRemoved({ tenantId: tenant, userId }, sourceId, refs) });
      }
      case "/v1/sources": {
        if (!userSources) return fail(404, "per-user sources are not configured (EDEN_USER_SOURCES_FILE)");
        if (badId(body, ["userId"])) return fail(400, "userId must be 1-128 characters of [A-Za-z0-9._:@-]");
        const status = await userSources.status({ tenantId: tenant, userId: body.userId as string });
        // The caller's (the integrator's) configuration for this user, not an internal failure: 422, not 5xx.
        if (status.error !== null) return fail(422, `source configuration: ${status.error}`);
        return json({ sources: status.sources });
      }
      default:
        return fail(404, "no such route");
    }
  }
}
