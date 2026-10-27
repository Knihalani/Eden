import { createHmac, timingSafeEqual } from "node:crypto";
import type { EdenDb } from "./db";
import { dropResult, isMutatingMethod, publicResultKey, resultCacheKey, type ResultCacheIdentity } from "./cache";
import { maybeRecompile, type MaybeRecompileInput } from "./canary";
import { canaryWorkspaceDeps } from "./canary-bind";

/**
 * External change knocks the GET envelope the way drift auto-refresh already
 * knocks: named keys drop, the next read is a miss, the live tool stays On
 * until a human Approves a replacement. This module never pauses, never
 * rewrites the live program, and never invents a POST cache.
 *
 * A replacement card is queued only when recompile+shadow PASSes. Cloning
 * live steps is not a replacement.
 */

export const WEBHOOK_HEADER = "x-eden-webhook";
export const WEBHOOK_SIG_HEADER = "x-eden-webhook-signature";
export const HUB_SIG_HEADER = "x-hub-signature-256";
export const WEBHOOK_SECRET_ENV = "EDEN_WEBHOOK_SECRET";
/** One-release hatch: `1` restores named `x-eden-webhook` / Bearer / raw Authorization. */
export const WEBHOOK_RAW_ENV = "EDEN_WEBHOOK_RAW";

/** Sibling of Wave 6 refresh copy — cache drop, not a field rename. */
export const WEBHOOK_WAITING_COPY =
  "An outside GET cache was invalidated. A replacement is waiting. The live tool is unchanged until you Approve.";
export const WEBHOOK_DROPPED_COPY = "GET cache dropped. The live tool is still On.";
export const WEBHOOK_NOOP_COPY = "No keys dropped.";

export type WebhookInvalidateBody = {
  keys?: unknown;
  url?: unknown;
  urls?: unknown;
  workspaceId?: unknown;
  toolId?: unknown;
  step?: unknown;
  bound?: unknown;
  method?: unknown;
};

export type WebhookInvalidateResult = {
  dropped: string[];
  live: string | null;
  message: string;
  queued?: boolean;
};

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function webhookHmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function presentedSignatureHex(req: Request): { present: boolean; hex: string | null } {
  const raw = req.headers.get(WEBHOOK_SIG_HEADER) || req.headers.get(HUB_SIG_HEADER);
  if (!raw) return { present: false, hex: null };
  // GitHub always presents `sha256=<hex>`. Bare hex is present-but-malformed.
  const m = /^sha256=([0-9a-fA-F]+)$/i.exec(raw.trim());
  return { present: true, hex: m ? m[1]!.toLowerCase() : null };
}

/** Present shared secret from the named header or Authorization (RAW=1 hatch only). */
export function presentedWebhookSecret(req: Request): string | null {
  const named = req.headers.get(WEBHOOK_HEADER);
  if (named) return named;
  const auth = req.headers.get("authorization") || "";
  const bearer = /^Bearer\s+(.*)$/i.exec(auth);
  if (bearer) return bearer[1]!;
  if (auth && !auth.includes(" ")) return auth;
  return null;
}

/**
 * Fail closed when no secret is configured — even a well-formed HMAC is 401.
 * Default authenticator is HMAC-SHA256 of the raw body
 * (`x-eden-webhook-signature` / `x-hub-signature-256`, `sha256=<hex>`),
 * compared with timingSafeEqual. The shared secret is never a request header.
 * `EDEN_WEBHOOK_RAW=1` restores named `x-eden-webhook` / Bearer / raw
 * Authorization as aliases of that path for one release.
 */
export function webhookAuthStatus(
  req: Request,
  configured = process.env[WEBHOOK_SECRET_ENV],
  rawBody = "",
  rawHatch = process.env[WEBHOOK_RAW_ENV],
): 200 | 401 | 403 {
  if (!configured) return 401;
  const sig = presentedSignatureHex(req);
  if (sig.present) {
    if (!sig.hex) return 403;
    const expect = webhookHmacHex(configured, rawBody);
    return timingSafeEqualStr(sig.hex, expect) ? 200 : 403;
  }
  if (rawHatch !== "1") return 401;
  const got = presentedWebhookSecret(req);
  if (got === null) return 401;
  return timingSafeEqualStr(got, configured) ? 200 : 403;
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

function asStep(value: unknown, methodHint?: unknown): ResultCacheIdentity["step"] | null {
  const rec = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const id = typeof rec.id === "string" && rec.id ? rec.id : typeof rec.name === "string" && rec.name ? rec.name : "";
  if (!id) return null;
  const name = typeof rec.name === "string" ? rec.name : id;
  const methodRaw = typeof rec.method === "string" ? rec.method : typeof methodHint === "string" ? methodHint : "GET";
  return { id, name, method: methodRaw || "GET" };
}

function asBound(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Keys this webhook is allowed to name. Explicit `rc:` / `rcp:` hashes, plus
 * identity-derived keys for a GET. A public GET of the same URL identity
 * drops `rcp:` too. Other tenants' private `rc:` keys are never enumerated.
 * Mutating methods were never cached — identity with POST/PUT/PATCH/DELETE
 * adds nothing (do not invent a POST cache). Empty input → empty set (no-op,
 * not a wipe).
 */
export function keysToDrop(body: WebhookInvalidateBody): string[] {
  const named = new Set<string>();
  const raw = [...asStringList(body.keys), ...asStringList(body.url), ...asStringList(body.urls)];
  for (const k of raw) {
    if (k.startsWith("rc:") || k.startsWith("rcp:")) named.add(k);
  }

  const urls = raw.filter((u) => !u.startsWith("rc:") && !u.startsWith("rcp:"));
  const toolId = typeof body.toolId === "string" ? body.toolId : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const step = asStep(body.step, body.method);
  const bound = asBound(body.bound);

  if (
    toolId &&
    step &&
    urls.length &&
    !isMutatingMethod(step.method) &&
    (step.method || "GET").toUpperCase() === "GET"
  ) {
    for (const url of urls) {
      const publicId = { toolId, step, url, bound };
      named.add(publicResultKey(publicId));
      if (workspaceId) named.add(resultCacheKey({ ...publicId, workspaceId }));
    }
  }

  return [...named];
}

function webhookMessage(dropped: string[], queued: boolean): string {
  if (queued) return WEBHOOK_WAITING_COPY;
  if (dropped.length) return WEBHOOK_DROPPED_COPY;
  return WEBHOOK_NOOP_COPY;
}

/**
 * Recompile from traces (same gate as drift canary). Threshold 0 — a cache
 * drop is the signal, not a deopt count. No traces / FAIL → no draft.
 */
async function queueWebhookRefresh(
  db: EdenDb,
  workspaceId: string,
  toolId: string,
  deps: Omit<MaybeRecompileInput, "workspace_id" | "tool_id">,
): Promise<boolean> {
  try {
    const out = await maybeRecompile(db, {
      ...deps,
      workspace_id: workspaceId,
      tool_id: toolId,
      threshold: 0,
      waitingCopy: WEBHOOK_WAITING_COPY,
    });
    return out.action === "queued";
  } catch {
    return false;
  }
}

export async function invalidateFromWebhook(
  db: EdenDb,
  body: WebhookInvalidateBody,
  deps: Omit<MaybeRecompileInput, "workspace_id" | "tool_id"> = canaryWorkspaceDeps(),
): Promise<WebhookInvalidateResult> {
  const named = keysToDrop(body);
  const dropped: string[] = [];
  try {
    for (const key of named) {
      if (await dropResult(db, key)) dropped.push(key);
    }
  } catch {
    /* a broken drop is a miss next time, not a 500 */
  }

  let live: string | null = null;
  const toolId = typeof body.toolId === "string" ? body.toolId : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (toolId) {
    try {
      const row = workspaceId
        ? await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = ? AND workspace_id = ?`, [
            toolId,
            workspaceId,
          ])
        : await db.get<{ state: string }>(`SELECT state FROM tool WHERE id = ?`, [toolId]);
      live = row?.state ?? null;
    } catch {
      live = null;
    }
  }

  let queued = false;
  if (named.length && toolId && workspaceId) {
    queued = await queueWebhookRefresh(db, workspaceId, toolId, deps);
  }

  return { dropped, live, message: webhookMessage(dropped, queued), queued };
}

export async function handleWebhook(db: EdenDb, req: Request): Promise<Response> {
  try {
    const text = await req.text();
    const auth = webhookAuthStatus(req, process.env[WEBHOOK_SECRET_ENV], text);
    if (auth !== 200) {
      return Response.json({ error: "unauthorized" }, { status: auth });
    }

    let body: WebhookInvalidateBody = {};
    if (text.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return Response.json({ error: "expected a json object body" }, { status: 400 });
      }
      body = parsed as WebhookInvalidateBody;
    }

    const result = await invalidateFromWebhook(db, body);
    return Response.json(result);
  } catch {
    return Response.json({ dropped: [], live: null, message: WEBHOOK_NOOP_COPY, queued: false }, { status: 200 });
  }
}
