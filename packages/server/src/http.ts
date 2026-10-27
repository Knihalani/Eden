/**
 * The HTTP API an agent integration calls. All routes take and return JSON.
 *
 *   POST /v1/events    an AgentEvent              → ObserveResult  (?waitMs= to wait for the slow path)
 *   POST /v1/ask       an AskRequest              → AskResponse
 *   POST /v1/pending   {tenantId,userId,sessionId} → {injections}
 *   POST /v1/feedback  a Feedback (used: boolean)  → {ok, applied}
 *   POST /v1/forget    {tenantId,userId,sourceId?} → {ok}
 *   GET  /healthz
 *
 * Auth: `Authorization: Bearer <key>`; the key fixes the tenant, and a body naming another tenant is refused.
 * Each tenant is rate limited (GCRA, `ServerConfig.tenantRatePerSec` / `tenantBurst`): past it, 429 with Retry-After,
 * so one tenant cannot starve the others.
 * Errors are `{error}` with a 4xx for the caller's mistakes; nothing the caller sends can produce a 500.
 */
import type { ContextPartner } from "@eden/engine";
import { Gcra } from "@eden/primitives";
import { checkAsk, checkEvent, isId } from "@eden/protocol";
import type { ServerConfig } from "./config";

type Json = Record<string, unknown>;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

export function createHandler(
  partner: ContextPartner,
  config: Pick<ServerConfig, "keys" | "dev"> & Partial<Pick<ServerConfig, "tenantRatePerSec" | "tenantBurst">>,
) {
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
    let body: Json;
    try {
      const parsed: unknown = await req.json();
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
          return json(await partner.observe(checked.value, { waitMs }));
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
          return json({ injections: partner.takePending(who) });
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
          partner.forget({ tenantId: tenant, userId: body.userId as string }, body.sourceId as string | undefined);
          return json({ ok: true });
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
