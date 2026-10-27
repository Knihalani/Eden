/**
 * The HTTP API an agent integration calls. All routes take and return JSON.
 *
 *   POST /v1/events    an AgentEvent              → ObserveResult  (?waitMs= to wait for the slow path)
 *   POST /v1/ask       an AskRequest              → AskResponse
 *   POST /v1/pending   {tenantId,userId,sessionId} → {injections}
 *   POST /v1/feedback  a Feedback                 → {ok}
 *   POST /v1/forget    {tenantId,userId,sourceId?} → {ok}
 *   GET  /healthz
 *
 * Auth: `Authorization: Bearer <key>`; the key fixes the tenant, and a body naming another tenant is refused.
 * Errors are `{error}` with a 4xx for the caller's mistakes; nothing the caller sends can produce a 500.
 */
import type { ContextPartner } from "@eden/engine";
import { checkAsk, checkEvent, type Feedback } from "@eden/protocol";
import type { ServerConfig } from "./config";

type Json = Record<string, unknown>;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

export function createHandler(partner: ContextPartner, config: Pick<ServerConfig, "keys" | "dev">) {
  const tenantOf = (req: Request): string | null => {
    const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (key && config.keys.has(key)) return config.keys.get(key)!;
    return config.dev ? "dev" : null;
  };

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
    if (req.method !== "POST") return fail(405, "method not allowed");
    const tenant = tenantOf(req);
    if (!tenant) return fail(401, "missing or unknown API key");
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
          if (typeof body.userId !== "string" || typeof body.sessionId !== "string") {
            return fail(400, "userId and sessionId are required");
          }
          return json({
            injections: partner.takePending({ tenantId: tenant, userId: body.userId, sessionId: body.sessionId }),
          });
        }
        case "/v1/feedback": {
          const f = body as unknown as Feedback;
          if (typeof f.userId !== "string" || typeof f.sessionId !== "string" || typeof f.injectionId !== "string") {
            return fail(400, "userId, sessionId and injectionId are required");
          }
          partner.feedback({ ...f, tenantId: tenant, used: !!f.used, how: "explicit" });
          return json({ ok: true });
        }
        case "/v1/forget": {
          if (typeof body.userId !== "string") return fail(400, "userId is required");
          const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
          partner.forget({ tenantId: tenant, userId: body.userId }, sourceId);
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
