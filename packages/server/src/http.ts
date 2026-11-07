/**
 * The HTTP API an agent integration calls. All routes take and return JSON.
 *
 *   POST /v1/events    an AgentEvent              → ObserveResult  (?waitMs= to wait for the slow path)
 *   POST /v1/ask       an AskRequest              → AskResponse
 *   POST /v1/check     a tool_call AgentEvent     → ActionCheck   (the action firewall, `actionCheck`)
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
  checkSourceRemoved,
  isId,
} from "@eden/protocol";
import { DEFAULT_MAX_BODY_BYTES, type ServerConfig } from "./config";
import type { UserSources } from "./user-sources";

type Json = Record<string, unknown>;
const decoder = new TextDecoder();
const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

export function createHandler(
  partner: ContextPartner,
  config: Pick<ServerConfig, "keys" | "dev"> &
    Partial<Pick<ServerConfig, "tenantRatePerSec" | "tenantBurst" | "maxBodyBytes">>,
  /** Per-user sources (D108): forget closes the user's connections, and `/v1/sources` reports their config. */
  userSources?: UserSources,
) {
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const tooLarge = `body must be at most ${maxBodyBytes.toLocaleString("en-US")} bytes`;
  const limiter = new Gcra({ ratePerSec: config.tenantRatePerSec ?? 200, burst: config.tenantBurst ?? 400 });
  const tenantOf = (req: Request): string | null => {
    const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (key && config.keys.has(key)) return config.keys.get(key)!;
    // Dev mode accepts a missing key, never a wrong one: a typo'd production key must not land in tenant "dev".
    return config.dev && !key ? "dev" : null;
  };
  const badId = (body: Json, fields: string[]) => fields.find((f) => !isId(body[f]));

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
    if (req.method !== "POST") return fail(405, "method not allowed");
    const tenant = tenantOf(req);
    if (!tenant) return fail(401, "missing or unknown API key");
    const waitMs = limiter.take(tenant);
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
    try {
      const bytes = new Uint8Array(await req.arrayBuffer());
      // Before the parse, which is where a padded body's cost lies (D100's cap bounds bytes, not values or depth).
      if (!bodyShapeUnder(bytes)) return fail(400, "body holds too many values or nests too deep");
      const parsed: unknown = JSON.parse(decoder.decode(bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "body must be an object");
      body = parsed as Json;
    } catch {
      return fail(400, "body must be JSON");
    }
    body.tenantId ??= tenant;
    if (body.tenantId !== tenant) return fail(403, "tenantId does not match the API key");

    try {
      switch (url.pathname) {
        case "/v1/events": {
          const checked = checkEvent(body);
          if (!checked.ok) return fail(400, checked.error);
          const waitMs = Math.max(0, Math.min(5_000, Number(url.searchParams.get("waitMs") ?? 0) || 0));
          // `?shadow=1`: an integration trying Eden without injecting (the proxy's shadow mode): nothing is learned.
          const shadow = url.searchParams.get("shadow") === "1";
          return json(await partner.observe(checked.value, { waitMs, ...(shadow ? { shadow } : {}) }));
        }
        case "/v1/check": {
          // The action firewall: a tool call the agent is about to make, checked against what is held (no model).
          const checked = checkEvent(body);
          if (!checked.ok) return fail(400, checked.error);
          if (checked.value.kind !== "tool_call") return fail(400, "check takes a tool_call event");
          return json(await partner.checkAction(checked.value));
        }
        case "/v1/ask": {
          const checked = checkAsk(body);
          if (!checked.ok) return fail(400, checked.error);
          return json(await partner.ask(checked.value));
        }
        case "/v1/pending": {
          const bad = badId(body, ["userId", "sessionId"]);
          if (bad) return fail(400, `${bad} must be 1-128 characters of [A-Za-z0-9._:@-]`);
          const who = { tenantId: tenant, userId: body.userId as string, sessionId: body.sessionId as string };
          const shadow = url.searchParams.get("shadow") === "1";
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
        case "/v1/forget": {
          if (badId(body, ["userId"])) return fail(400, "userId must be 1-128 characters of [A-Za-z0-9._:@-]");
          if (body.sourceId !== undefined && !isId(body.sourceId)) return fail(400, "sourceId is malformed");
          const scope = { tenantId: tenant, userId: body.userId as string };
          partner.forget(scope, body.sourceId as string | undefined);
          userSources?.forget(scope, body.sourceId as string | undefined);
          return json({ ok: true });
        }
        case "/v1/sources/changed": {
          // A webhook or watch the integrator receives, forwarded: the source's synced copy is polled at its next use.
          const checked = checkSourceChanged(body);
          if (!checked.ok) return fail(400, checked.error);
          const { userId, sourceId } = checked.value;
          // 200 either way (a no-op notification is not a caller error); `reason` says why nothing was synced.
          return json({ ok: true, ...partner.sourceNotice({ tenantId: tenant, userId }, sourceId) });
        }
        case "/v1/sources/items": {
          // The changed items themselves (a Slack event, a trigger's payload): held as synced, with no source call.
          const checked = checkSourceItems(body);
          if (!checked.ok) return fail(400, checked.error);
          const { userId, sourceId, items } = checked.value;
          return json({ ok: true, stored: await partner.sourceItems({ tenantId: tenant, userId }, sourceId, items) });
        }
        case "/v1/sources/removed": {
          // A deletion the integrator was told of (a recalled message, a deleted doc or event): dropped at once.
          const checked = checkSourceRemoved(body);
          if (!checked.ok) return fail(400, checked.error);
          const { userId, sourceId, refs } = checked.value;
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
    } catch (e) {
      console.error("eden: request failed", url.pathname, e instanceof Error ? e.message : e);
      return fail(503, "temporarily unable to serve context"); // An integration treats this as silence.
    }
  };
}
