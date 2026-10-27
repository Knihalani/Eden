import { openDb, workspaceForKey, isManagedDeployment, hashApiKey, type EdenDb } from "./db";
import { ingest } from "./cluster";
import { handleMcp, liveOnTools, wrapDispatchResult, toolRowToProgram } from "./mcp";
import { playTool } from "./playback";
import { handleForge } from "./forge";
import { copyBtn, escapeHtml, landingLayout, layout, nav } from "./html";
import { servePublic } from "./assets";
import { findOnTool, wrapPlay, toolHasPlayback } from "./wrap";
import { buildLedger, ensureLedgerSchema, sanitizeManifest, type LedgerFigure } from "./ledger";
import { handleWebhook } from "./webhook";
import { detectAndParse } from "@eden/core";
import { protocolCheck, EDEN_PROTOCOL_VERSION, PROTOCOL_HEADER, redact } from "@eden/ir";
import type { ToolEvent } from "@eden/core";
import { createState, handleChatCompletions } from "@eden/wrap";

/** A malformed PORT must fall back, not hand NaN to Bun.serve. */
export function envPort(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

const PORT = envPort(process.env.PORT, 8787);
let dbPromise: Promise<EdenDb> | null = null;

function db(): Promise<EdenDb> {
  if (!dbPromise) {
    // A failed open must not be cached: dbPromise would otherwise hold the
    // rejection forever and every later request would fail until the process
    // restarted, even though the transient outage that caused it had cleared.
    // The rejection still surfaces to the request that triggered the open —
    // the next one gets a fresh attempt.
    dbPromise = openDb(process.env.EDEN_DB || undefined)
      .then(async (d) => {
        await seedBundle(d);
        return d;
      })
      .catch((err: unknown) => {
        dbPromise = null;
        throw err;
      });
  }
  return dbPromise;
}

async function seedBundle(d: EdenDb) {
  if (process.env.EDEN_SKIP_SEED === "1") return;
  const existing = await d.get<{ id: string }>(
    `SELECT id FROM tool WHERE name = 'fetch_issue_bundle' AND workspace_id = 'ws_local'`,
  );
  const steps = [
    { id: "s1", kind: "cloud_http", name: "issue", commute: true, url: "{origin}/forge/repos/acme/app/issues/{issue}" },
    {
      id: "s2",
      kind: "cloud_http",
      name: "comments",
      commute: true,
      url: "{origin}/forge/repos/acme/app/issues/{issue}/comments",
    },
    { id: "s3", kind: "cloud_http", name: "pull", commute: true, url: "{origin}/forge/repos/acme/app/pulls/{issue}" },
    {
      id: "s4",
      kind: "cloud_http",
      name: "reviews",
      commute: true,
      url: "{origin}/forge/repos/acme/app/pulls/{issue}/reviews",
    },
    {
      id: "s5",
      kind: "cloud_http",
      name: "status",
      commute: true,
      url: "{origin}/forge/repos/acme/app/commits/abc{issue}/status",
    },
    {
      id: "s6",
      kind: "cloud_http",
      name: "runs",
      commute: true,
      url: "{origin}/forge/repos/acme/app/actions/runs?pr={issue}",
    },
  ];
  const when = "Prefer this over six curl/gh calls for issue+PR+checks.";
  const seen = JSON.stringify([
    "gh.pr.view",
    "curl.get",
    "gh.api",
    "get_issue",
    "list_comments",
    "issue",
    "comments",
    "pull",
    "reviews",
    "status",
    "runs",
  ]);
  if (existing) {
    await d.run(`UPDATE tool SET steps = ?, when_to_use = ?, seen = ?, required_k = 2, published = 1 WHERE id = ?`, [
      JSON.stringify(steps),
      when,
      seen,
      existing.id,
    ]);
    return;
  }
  await d.run(
    `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k, published)
     VALUES (?, 'ws_local', 'fetch_issue_bundle', ?, 'on', ?, ?, 'seed_bundle', 2, 1)`,
    [crypto.randomUUID(), when, JSON.stringify(steps), seen],
  );
}

function html(title: string, body: string) {
  return new Response(layout(title, body), { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  try {
    return { ok: true, value: await req.json() };
  } catch {
    return { ok: false, res: Response.json({ error: "invalid json" }, { status: 400 }) };
  }
}

/**
 * JSON that parses is not JSON we can serve. `null`, an array or a scalar
 * reaches the handlers as a typed cast today and then throws somewhere
 * deeper — a 500 with a stack trace for what is plainly a bad request.
 */
function readJsonObject(
  parsed: { ok: true; value: unknown } | { ok: false; res: Response },
): { ok: true; value: Record<string, unknown> } | { ok: false; res: Response } {
  if (!parsed.ok) return parsed;
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { ok: false, res: Response.json({ error: "expected a json object body" }, { status: 400 }) };
  }
  return parsed as { ok: true; value: Record<string, unknown> };
}

/**
 * JSON columns written by older builds (or by a crashed writer) can hold
 * anything. Every parse below feeds `.map()`/`.some()`, so a scalar or an
 * object would throw out of a page render — the empty-array fallback degrades
 * one row instead of failing the whole endpoint.
 */
function jsonRows(raw: string | null | undefined): unknown[] {
  try {
    const v = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Rejects a state-changing request that a *page the user was visiting* could
 * have made on their behalf.
 *
 * workspaceForKey() grants ws_local to a request with no Authorization header
 * at all on any non-managed install, which is the default. There is no cookie,
 * so there is no SameSite boundary, and a cross-origin form POST needs no
 * preflight — so any page the user visited could POST /v1/tools/:id/approve and
 * turn a compiled tool On, or POST /v1/ingest and poison the workspace. That
 * defeats the invariant the workshop page itself asserts: "Approve only here —
 * a key never turns a tool On."
 *
 * The workshop's own forms are same-origin, and CLI/API callers send no Origin
 * at all, so requiring "absent, or equal to ours" costs neither of them
 * anything while removing the drive-by entirely.
 */
function crossOriginWrite(req: Request, selfOrigin: string): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin !== new URL(selfOrigin).origin;
  } catch {
    return true;
  }
}

/**
 * Host names a caller that really means *this* deployment will have used.
 *
 * Loopback variants, plus the configured public origin when the environment
 * names one (EDEN_PUBLIC_URL, or VERCEL_URL on Vercel). selfOrigin is
 * deliberately NOT trusted here: Bun derives req.url from the Host header,
 * so echoing it back would validate whatever name an attacker asked for.
 */
function publicSiteOrigin(url: URL): string {
  const env = (process.env.EDEN_PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (env) return env;
  const prod = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim().replace(/\/$/, "");
  if (prod) return prod.startsWith("http") ? prod : `https://${prod}`;
  if (process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL.replace(/^https?:\/\//, "");
    return `https://${host}`;
  }
  return `http://127.0.0.1:${url.port || PORT}`;
}

function allowedHostNames(): Set<string> {
  const hosts = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);
  const candidates = [
    process.env.EDEN_PUBLIC_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? process.env.VERCEL_PROJECT_PRODUCTION_URL.startsWith("http")
        ? process.env.VERCEL_PROJECT_PRODUCTION_URL
        : `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "",
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
  ];
  for (const candidate of candidates) {
    try {
      if (candidate) hosts.add(new URL(candidate).hostname.toLowerCase());
    } catch {
      /* a malformed configured origin simply adds nothing */
    }
  }
  return hosts;
}

/**
 * The cross-origin checks above are relative to an origin derived from the
 * request itself, so they do not survive DNS rebinding: a page on
 * http://evil.test whose hostname re-resolves to this server sends no Origin,
 * `Sec-Fetch-Site: same-origin`, and a request-derived origin that matches
 * its own — every check passes. The one header that still tells the truth is
 * Host, which carries the name the client *asked* for rather than the address
 * it reached (hookd's hostIsLoopback makes the same argument).
 *
 * HTTPS requests are exempt: TLS binds the name, and a rebinding page cannot
 * present a valid certificate for one it rebound.
 *
 * A missing Host is refused. RFC 7230 §5.4 requires every HTTP/1.1 request to
 * carry Host, so an absent header is either malformed or pre-HTTP/1.1 — and
 * Bun's Request does not expose which, so the version exemption cannot be
 * detected honestly. Fail-open for everything would restore the DNS-rebinding
 * hole this check exists to close (a rebinder can simply omit Host). The one
 * concession: body-less GET/HEAD reads are still admitted, because they carry
 * no write for a rebinding page to forge and legacy clients plausibly predate
 * Host. Everything that can mutate is refused without one.
 */
function hostHeaderMatchesDeployment(req: Request): boolean {
  const raw = req.headers.get("host");
  if (!raw) {
    // GET/HEAD cannot carry a body by fetch-spec construction, so the null
    // check below only ever documents intent — but it keeps this exception
    // honest if a bodiless read method is ever widened.
    const bodilessRead = (req.method === "GET" || req.method === "HEAD") && req.body === null;
    return bodilessRead;
  }
  try {
    if (new URL(req.url).protocol === "https:") return true;
  } catch {
    /* fall through to the check below */
  }
  const host = raw
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return allowedHostNames().has(host);
}

/**
 * One wording rule for the ledger, on the page and in the endpoint: a number
 * shows only where evidence backs it. No measurement means "not measured" —
 * never zero, and an estimate is always labelled as one.
 */
function savingsWord(f: LedgerFigure & { estimated?: boolean }): string {
  if (f.measured && f.value != null) return `${Math.round(f.value)} (measured)`;
  if (f.estimated && f.value != null) return `${Math.round(f.value)} (estimated)`;
  return "not measured";
}

const AGENT_OPENAPI = {
  openapi: "3.0.0",
  info: { title: "Eden wrap", version: String(EDEN_PROTOCOL_VERSION) },
  paths: {
    "/health": { get: { summary: "Wrap facts (ok, protocol, service, traces/live when keyed). No auth for ok." } },
    "/v1/wrap": {
      post: { summary: "Ask if a compiled tool answers. 200 {action:play,facts} or {action:original}." },
    },
    "/v1/ingest": { post: { summary: "Record tool events; stretch_end compiles. Does not Approve." } },
    "/v1/dispatch": { post: { summary: "JIT: at most one compiled schema. {tools}." } },
    "/v1/chat/completions": { post: { summary: "OpenAI-compatible chat; set OPENAI_BASE_URL here. Auth required." } },
  },
};

function unauthorizedJson(): Response {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) } },
  );
}

/** 401 for a chat call that brought no model key of its own: the site never pays for one (#91). */
function providerKeyRequired(): Response {
  return Response.json(
    {
      error: {
        message:
          "Send your own model provider key as Authorization: Bearer <key> (or x-openai-api-key), " +
          "with your Eden key in x-eden-api-key. Eden does not pay for model calls.",
        type: "invalid_request_error",
        code: "provider_key_required",
      },
    },
    { status: 401, headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) } },
  );
}

let warnedNoClientAddress = false;

/**
 * The client address the signup rate limit counts (#91). x-real-ip and x-forwarded-for say
 * whatever the caller sent, so they count only behind a proxy that sets them: Vercel's, or one
 * the operator vouches for with EDEN_TRUST_PROXY=1. Of x-forwarded-for, the last hop: a proxy
 * that appends (nginx's default) leaves the caller's own claims in front of it. Otherwise the
 * socket address (`peer`, which local.ts passes), and with neither, one bucket that every
 * caller shares, which is logged once.
 */
function signupClientAddress(req: Request, peer?: string): string {
  if (process.env.VERCEL || process.env.EDEN_TRUST_PROXY === "1") {
    const hops = (req.headers.get("x-forwarded-for") || "").split(",").map((h) => h.trim());
    const forwarded = req.headers.get("x-real-ip")?.trim() || hops.filter(Boolean).pop();
    if (forwarded) return forwarded;
  }
  if (peer?.trim()) return peer.trim();
  if (!warnedNoClientAddress) {
    warnedNoClientAddress = true;
    console.warn(
      "eden site: the signup rate limit sees no client address, so every signup shares one bucket. " +
        "Behind a proxy that sets X-Real-IP itself (not the client's), set EDEN_TRUST_PROXY=1.",
    );
  }
  return "unknown";
}

/** Wrap auth: x-eden-api-key, a wrap-shaped Bearer, or the HTML session cookie. */
export function wrapTokenFromRequest(req: Request): string {
  const named = (req.headers.get("x-eden-api-key") || req.headers.get("x-eden-key") || "").trim();
  if (named) return named;
  const bearer =
    req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() || "";
  if (bearer === "eden_dev" || bearer.startsWith("eden_")) return bearer;
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(/(?:^|;\s*)eden_key=([^;]*)/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1] ?? "").trim();
  } catch {
    return "";
  }
}

/**
 * The model provider key a chat caller brought: x-openai-api-key, or a bearer that is not an Eden
 * key (the setup page tells agents to send their provider key as Authorization). Empty: none.
 */
function callerProviderKey(req: Request): string {
  const header = (req.headers.get("x-openai-api-key") || req.headers.get("openai-api-key") || "").trim();
  const bearer =
    req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim() || "";
  return [header, bearer].find((k) => k && !k.startsWith("eden_")) ?? "";
}

function sessionCookie(token: string): string {
  const parts = [`eden_key=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=2592000"];
  if (isManagedDeployment()) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(): string {
  const parts = ["eden_key=", "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (isManagedDeployment()) parts.push("Secure");
  return parts.join("; ");
}

const siteWrapState = createState({});

/** `peer`: the socket address of the caller, when the server knows it (local.ts). */
export async function handleFetch(req: Request, peer?: string): Promise<Response> {
  // Same predicate as authentication uses: auto-approve must be impossible
  // anywhere a key is actually required, not only on Vercel.
  if (isManagedDeployment() && process.env.EDEN_DEV !== "1") {
    delete process.env.EDEN_AUTO_APPROVE;
  }
  const url = new URL(req.url);
  const asset = await servePublic(url.pathname);
  if (asset) return asset;
  // Health must not open the database — Next collect-page-data and load
  // balancers hit this path, and bun:sqlite is not on the hosted Node runtime.
  if (url.pathname === "/health") {
    const headers = { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) };
    const base = {
      ok: true as const,
      protocol: EDEN_PROTOCOL_VERSION,
      service: "eden-wrap",
      wrap: true,
      ingest: true,
      dispatch: true,
    };
    if (process.env.NEXT_PHASE === "phase-production-build") {
      return Response.json({ ok: true, protocol: EDEN_PROTOCOL_VERSION }, { headers });
    }
    try {
      const healthDb = await db();
      const wsId = await workspaceForKey(healthDb, req.headers.get("authorization"));
      if (!wsId) return Response.json(base, { headers });
      const traces = Number(
        (
          await healthDb.get<{ c: number }>(
            `SELECT COUNT(*) as c FROM (
               SELECT DISTINCT run_id FROM stretch WHERE workspace_id = ?
               UNION
               SELECT DISTINCT run_id FROM tool_event WHERE workspace_id = ?
             )`,
            [wsId, wsId],
          )
        )?.c ?? 0,
      );
      const live = Number(
        (
          await healthDb.get<{ c: number }>(`SELECT COUNT(*) as c FROM tool WHERE workspace_id = ? AND state = 'on'`, [
            wsId,
          ])
        )?.c ?? 0,
      );
      const candidates = Number(
        (
          await healthDb.get<{ c: number }>(`SELECT COUNT(*) as c FROM cluster WHERE workspace_id = ? AND count >= 2`, [
            wsId,
          ])
        )?.c ?? 0,
      );
      return Response.json({ ...base, traces, live, candidates }, { headers });
    } catch {
      return Response.json({ ok: true, protocol: EDEN_PROTOCOL_VERSION, service: "eden-wrap" }, { headers });
    }
  }
  // Next collect-page-data loads this catch-all during `next build`. Opening
  // sqlite or Neon there either throws (no bun:sqlite) or needs secrets.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return new Response(null, { status: 204 });
  }
  const d = await db();
  const origin = publicSiteOrigin(url);

  const forge = handleForge(url);
  if (forge) return forge;

  // Protocol gate on the /v1/* API surface: a client speaking a different
  // wire version gets an explicit 426 instead of obscure shape failures.
  if (url.pathname.startsWith("/v1/")) {
    const gate = protocolCheck(req.headers.get(PROTOCOL_HEADER));
    if (!gate.ok) {
      return Response.json(
        { error: gate.reason },
        { status: gate.status, headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) } },
      );
    }
  }

  // One gate for every write, rather than per-route: a route added later is
  // covered by default instead of by remembering. Host validation rides the
  // same gate and the same response class — to a rebinding page it is just
  // another cross-origin refusal.
  if (
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    (crossOriginWrite(req, url.origin) || !hostHeaderMatchesDeployment(req))
  ) {
    return new Response("cross-origin write refused", { status: 403 });
  }

  const wrapToken = wrapTokenFromRequest(req);
  const wsId = await workspaceForKey(d, wrapToken ? `Bearer ${wrapToken}` : null);

  /**
   * Auth gate for HTML pages: a signed-out browser is sent to onboarding
   * instead of a bare 401 body it cannot act on. API clients (no text/html in
   * Accept, or non-GET) still get the machine-readable 401.
   */
  function pageAuth(req: Request, wsId: string | null): Response | null {
    if (wsId) return null;
    const wantsHtml = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
    if (!wantsHtml) return new Response("unauthorized", { status: 401 });
    const url = new URL(req.url);
    return new Response(null, {
      status: 302,
      headers: { location: `/onboarding?next=${encodeURIComponent(url.pathname)}` },
    });
  }

  if (url.pathname === "/onboarding") {
    if (!wsId) {
      return html(
        "Eden — Sign in",
        nav("Sign in", false) +
          `<h1>Sign in</h1>
<p class="sub">Paste the key from signup. It stays in this browser.</p>
<form id="signInForm">
  <div class="field">
    <label for="apiKey">API key</label>
    <input type="text" id="apiKey" name="api_key" placeholder="eden_…" autocomplete="off" spellcheck="false" autofocus/>
  </div>
  <button type="submit" class="btn" id="signInBtn">Continue</button>
  <p id="signInErr" class="error-text" role="status" style="margin-top:10px"></p>
</form>
<p class="muted" style="margin-top:1.5rem">No key? <a class="inline" href="/signup">Create a workspace</a>.</p>
<script>
document.getElementById("signInForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("signInErr");
  const btn = document.getElementById("signInBtn");
  err.textContent = "";
  btn.disabled = true;
  const raw = document.getElementById("apiKey").value.trim().replace(/^EDEN_API_KEY=/, "");
  try {
    const res = await fetch("/v1/session", { method: "POST", headers: \
{"content-type":"application/json"}, body: JSON.stringify({ api_key: raw }) });
    if (!res.ok) { err.textContent = "That key did not authenticate."; btn.disabled = false; return; }
    const next = new URLSearchParams(location.search).get("next") || "/dashboard";
    location.href = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  } catch {
    err.textContent = "Could not reach Eden. Try again.";
    btn.disabled = false;
  }
});
</script>`,
      );
    }
    const tc = Number(
      (
        (await d.get<{ c: number }>(`SELECT COUNT(DISTINCT run_id) as c FROM stretch WHERE workspace_id = ?`, [
          wsId,
        ])) ?? { c: 0 }
      ).c,
    );
    const cc = Number(
      (
        (await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM cluster WHERE workspace_id = ? AND count >= 2`, [
          wsId,
        ])) ?? { c: 0 }
      ).c,
    );
    const live = Number(
      (
        (await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM tool WHERE workspace_id = ? AND state = 'on'`, [
          wsId,
        ])) ?? { c: 0 }
      ).c,
    );
    const setupPrompt = [
      `OPENAI_BASE_URL=${origin.replace(/\/$/, "")}/v1`,
      "OPENAI_API_KEY=<your provider key — sent as Authorization>",
      "EDEN_API_KEY=<your Eden key — sent as x-eden-api-key>",
    ].join("\n");
    const status =
      live > 0
        ? `<p class="status">A compiled tool is live. Matching calls use it. <a class="inline" ` +
          `href="/workshop">Review</a></p>`
        : cc > 0
          ? `<p class="status">${cc} draft${cc === 1 ? "" : "s"} waiting. Nothing is live until you Approve. <a ` +
            `class="inline" href="/workshop">Open Approve</a></p>`
          : tc > 0
            ? `<p class="status">${tc} run${tc === 1 ? "" : "s"} recorded. Repeats become drafts.</p>`
            : `<p class="status">Waiting for the first run. <a class="inline" href="/import">Import traces</a> if ` +
              `you already have them.</p>`;
    return html(
      "Eden — Setup",
      nav("Setup", true) +
        `<div class="page-head"><h1>Point the agent here</h1><a href="/dashboard">Skip to dashboard</a></div>
<p class="sub">Two keys. Nothing changes until you Approve.</p>
<pre><code>${escapeHtml(setupPrompt)}</code>${copyBtn()}</pre>
<p class="muted">The SDK <code>apiKey</code> is the provider key. Send the Eden key as <code>x-eden-api-key</code>.</p>
${status}
<details class="more">
<summary>What this will not do</summary>
<p>A key never flips a tool On. Out-of-range inputs fall back to the old path. If Eden breaks, \
traffic still goes through.</p>
</details>`,
    );
  }

  // Trace import page — cold-start elimination via observability exports.
  if (url.pathname === "/import") {
    const denied = pageAuth(req, wsId);
    if (denied) return denied;
    if (!wsId) return new Response("unauthorized", { status: 401 }); // unreachable; narrows for TS
    const body =
      nav("Import", true) +
      `
<h1>Import traces</h1>
<p class="sub">LangSmith, OpenTelemetry, OpenAI, or JSONL. Repeats become drafts.</p>
<form id="importForm">
  <label for="traceContent">Export</label>
  <textarea id="traceContent" rows="12" placeholder="Paste an export…"></textarea>
  <div class="row">
    <button type="submit" class="btn secondary">Import</button>
    <span id="status" class="muted"></span>
  </div>
</form>
<div id="results"></div>
<script>
document.getElementById("importForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = document.getElementById("traceContent").value;
  const status = document.getElementById("status");
  const results = document.getElementById("results");
  if (!content.trim()) { status.textContent = "Paste some trace data first."; return; }
  status.textContent = "Importing…";
  results.replaceChildren();
  const mark = (el, text, cls) => {
    el.textContent = "";
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    el.appendChild(span);
  };
  try {
    const res = await fetch("/v1/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const j = await res.json();
    if (res.ok) {
      mark(status, "Imported", "success");
      const p = document.createElement("p");
      p.className = "status";
      const n = Number(j.traces) || 0;
      const fmt = typeof j.format === "string" ? j.format : "export";
      p.append(document.createTextNode(n + " trace" + (n === 1 ? "" : "s") + " from " + fmt + ". "));
      const next = document.createElement("a");
      next.href = "/workshop";
      next.className = "inline";
      next.textContent = "Open Approve";
      p.appendChild(next);
      results.appendChild(p);
    } else {
      mark(status, "Import failed", "error-text");
      const p = document.createElement("p");
      p.className = "status";
      p.textContent = typeof j.error === "string" && j.error ? j.error : "Could not read that data. \
Try JSONL — one run per line.";
      results.appendChild(p);
    }
  } catch (err) {
    mark(status, "Import failed", "error-text");
    results.textContent = String(err);
  }
});
</script>`;
    return html("Import traces", body);
  }

  // The public front door: a proper landing for visitors, dashboard for users.
  if (url.pathname === "/" && !wsId) {
    const till =
      `<span class="till"><span class="slab"><span class="work" aria-hidden="true"></span><span ` +
      `class="go">Approve</span></span></span>`;
    const body = `
<main id="content">
  <div class="reel">
    <section class="hero">
      <header class="hero-header">
        <a class="brand" href="/" aria-label="Eden"><img class="brand-mark" src="/logo.webp" alt="" \
width="40" height="38" decoding="sync" fetchpriority="high"/><span class="brand-name">Eden</span></a>
        <a class="signin" href="/onboarding">Sign in</a>
      </header>
      <div class="hero-stage">
        <div class="promise">
          <h1>Making your agent do less work.</h1>
          <a class="btn ship" href="/signup">Sign up</a>
        </div>
        <div class="stage-slot">
          <button class="stage-hit" type="button" aria-pressed="false" aria-label="Repeated work. \
Move to turn. Scroll to keep one.">
            <canvas class="stage" aria-hidden="true"></canvas>
            <span class="deck" aria-hidden="true">${till}</span>
          </button>
          <span class="sr stage-live" aria-live="polite"></span>
        </div>
      </div>
    </section>
  </div>
  <section class="hold"><span class="go">Approve</span></section>
</main>`;
    return new Response(landingLayout("Eden", body), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/dashboard" || url.pathname === "/") {
    const denied = pageAuth(req, wsId);
    if (denied) return denied;
    if (!wsId) return new Response("unauthorized", { status: 401 }); // unreachable; narrows for TS
    // Lifetime totals for the counters; the money line is genuinely
    // *this month* — filtered on created_at, which rows written before the
    // column existed do not have (they stay in the lifetime numbers only).
    // One pass, not two: both aggregates come out of a single scan, which
    // halves the dashboard's database round trips on a remote driver.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const totals = await d.get<{
      runs: number;
      server_ms: number;
      steps: number;
      raw_bytes: number;
      densified_bytes: number;
      m_runs: number;
      m_server_ms: number;
      m_steps: number;
      m_raw_bytes: number;
      m_densified_bytes: number;
    }>(
      `SELECT COUNT(*) as runs,
              COALESCE(SUM(r.server_ms),0) as server_ms,
              COALESCE(SUM(r.steps_attempted),0) as steps,
              COALESCE(SUM(r.raw_bytes),0) as raw_bytes,
              COALESCE(SUM(r.densified_bytes),0) as densified_bytes,
              COALESCE(SUM(CASE WHEN r.created_at >= ? THEN 1 ELSE 0 END),0) as m_runs,
              COALESCE(SUM(CASE WHEN r.created_at >= ? THEN r.server_ms ELSE 0 END),0) as m_server_ms,
              COALESCE(SUM(CASE WHEN r.created_at >= ? THEN r.steps_attempted ELSE 0 END),0) as m_steps,
              COALESCE(SUM(CASE WHEN r.created_at >= ? THEN r.raw_bytes ELSE 0 END),0) as m_raw_bytes,
              COALESCE(SUM(CASE WHEN r.created_at >= ? THEN r.densified_bytes ELSE 0 END),0) as m_densified_bytes
       FROM tool_run r JOIN tool t ON t.id = r.tool_id WHERE t.workspace_id = ?`,
      [
        monthStart.getTime(),
        monthStart.getTime(),
        monthStart.getTime(),
        monthStart.getTime(),
        monthStart.getTime(),
        wsId,
      ],
    );
    const usage = totals || {
      runs: 0,
      server_ms: 0,
      steps: 0,
      raw_bytes: 0,
      densified_bytes: 0,
      m_runs: 0,
      m_server_ms: 0,
      m_steps: 0,
      m_raw_bytes: 0,
      m_densified_bytes: 0,
    };
    const month = {
      runs: Number(usage.m_runs),
      server_ms: Number(usage.m_server_ms),
      steps: Number(usage.m_steps),
      raw_bytes: Number(usage.m_raw_bytes),
      densified_bytes: Number(usage.m_densified_bytes),
    };
    const drafts = (await d.get<{ c: number }>(
      `SELECT COUNT(*) as c FROM tool WHERE workspace_id = ? AND state = 'draft'`,
      [wsId],
    )) || { c: 0 };
    const on = (await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM tool WHERE workspace_id = ? AND state = 'on'`, [
      wsId,
    ])) || { c: 0 };
    // The honest savings ledger, summarized in the same spare style. Absent
    // evidence renders as "not measured" — the dashboard must not say more
    // than the receipts behind it do.
    const ledger = await buildLedger(d, wsId);
    const recent = wsId
      ? await d.all<{ name: string; steps_ok: number; steps_attempted: number; server_ms: number; created_at: number }>(
          `SELECT t.name, r.steps_ok, r.steps_attempted, r.server_ms, r.created_at
       FROM tool_run r JOIN tool t ON t.id = r.tool_id
       WHERE t.workspace_id = ? ORDER BY r.created_at DESC LIMIT 8`,
          [wsId],
        )
      : [];
    const fmtWhen = (ts: number): string => {
      if (!ts) return "";
      const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.round(s / 60)}m ago`;
      if (s < 86400) return `${Math.round(s / 3600)}h ago`;
      return `${Math.round(s / 86400)}d ago`;
    };
    const activity = recent.length
      ? `<h2>Recent runs</h2>
         <table class="activity">${recent
           .map(
             (r) =>
               `<tr><td>${escapeHtml(r.name)}</td><td>${r.steps_ok}/${r.steps_attempted}</td><td ` +
               `class="num-cell">${fmtWhen(Number(r.created_at))}</td></tr>`,
           )
           .join("")}</table>`
      : "";
    const emptyDesk = ledger.runs === 0 && Number(drafts.c) === 0 && Number(on.c) === 0 && recent.length === 0;
    const fig = (label: string, val: string, dim = false) =>
      `<div><dt>${label}</dt><dd${dim ? ` class="dim"` : ""}>${escapeHtml(val)}</dd></div>`;
    const filled =
      `<h1>Desk</h1>` +
      (Number(drafts.c) > 0
        ? `<p class="callout"><a class="inline" href="/workshop">${drafts.c} waiting for Approve</a></p>`
        : `<p class="sub">Same stretch twice becomes a draft. Nothing goes live until you Approve.</p>`) +
      `<dl class="figures">
  ${fig("Tokens saved", savingsWord(ledger.tokens_saved_mean), !ledger.tokens_saved_mean.measured)}
  ${fig("Time saved", savingsWord(ledger.time_saved_ms_mean), !ledger.time_saved_ms_mean.measured)}
  ${fig("Compiled runs", ledger.runs === 0 ? "none yet" : String(ledger.runs), ledger.runs === 0)}
  ${fig("Live", on.c === 0 ? "none yet" : String(on.c), on.c === 0)}
</dl>` +
      (month.runs > 0
        ? `<p class="muted">${month.runs} compiled run${month.runs === 1 ? "" : "s"} this month.</p>`
        : "") +
      activity +
      `<div class="row">${
        Number(drafts.c) > 0
          ? `<a href="/workshop" class="btn">Go to Approve</a>`
          : `<a href="/onboarding" class="btn secondary">Setup</a>`
      }</div>`;
    const empty = `<div class="empty">
<h1>Your desk</h1>
<p class="sub">Nothing compiled yet. Point the agent at this host. After the same stretch twice, a \
draft shows up under Approve.</p>
<div class="row">
  <a href="/onboarding" class="btn secondary">Copy setup</a>
  <a href="/import" class="btn ghost">Import traces</a>
</div>
</div>`;
    const body = `<div class="desk">${nav("Desk", true)}${emptyDesk ? empty : filled}</div>`;
    return html("Eden — Desk", body);
  }

  if (url.pathname === "/workshop") {
    const denied = pageAuth(req, wsId);
    if (denied) return denied;
    if (!wsId) return new Response("unauthorized", { status: 401 }); // unreachable; narrows for TS
    const tools = await d.all<{ id: string; name: string; state: string; uses_count: number }>(
      `SELECT id, name, state, uses_count FROM tool WHERE workspace_id = ? ORDER BY CASE state WHEN ` +
        `'draft' THEN 0 WHEN 'on' THEN 1 ELSE 2 END, name`,
      [wsId],
    );
    const rows = tools
      .map(
        (t) =>
          `<li><a href="/workshop/${t.id}"><code>${escapeHtml(t.name)}</code></a><span ` +
          `class="state">${escapeHtml(t.state)}</span></li>`,
      )
      .join("");
    return html(
      "Eden — Approve",
      nav("Approve", true) +
        `<h1>Approve</h1>
<p class="sub">This is the only place a tool goes live.</p>
${
  rows
    ? `<ul class="tool-list">${rows}</ul>`
    : `<div class="empty">
<p class="sub">No drafts yet. Run the agent, or import traces.</p>
<div class="row"><a href="/import" class="btn secondary">Import traces</a></div></div>`
}`,
    );
  }

  const ws = url.pathname.match(/^\/workshop\/([^/]+)$/);
  if (ws && req.method === "GET") {
    const denied = pageAuth(req, wsId);
    if (denied) return denied;
    if (!wsId) return new Response("unauthorized", { status: 401 }); // unreachable; narrows for TS
    const t = await d.get<{
      id: string;
      name: string;
      when_to_use: string;
      state: string;
      steps: string;
      published?: number;
    }>(`SELECT id, name, when_to_use, state, steps, published FROM tool WHERE id = ? AND workspace_id = ?`, [
      ws[1],
      wsId,
    ]);
    if (!t) {
      return html(
        "Eden — Not found",
        nav("Approve", true) +
          `<h1>Not found</h1><p class="sub">This tool is not in your workspace.</p>
           <p class="row"><a href="/workshop" class="btn secondary">Back</a></p>`,
      );
    }
    const steps = jsonRows(t.steps) as Array<{ id: string; name: string; kind: string; url?: string }>;
    const list = steps.length
      ? `<h2>What it runs</h2><table class="activity">${steps
          .map(
            (s, i) => `<tr><td>${i + 1}. ${escapeHtml(String(s.name))}</td><td>${escapeHtml(String(s.kind))}</td></tr>`,
          )
          .join("")}</table>`
      : "";
    const approve =
      t.state !== "on"
        ? `<form method="post" action="/v1/tools/${t.id}/approve" class="row"><button type="submit" \
class="btn ship">Approve</button></form>
           <p class="muted">Matching calls will use this compiled tool. Reversible from this page later.</p>`
        : `<p class="status">Live. Matching calls in this workspace use this tool.</p>`;
    return html(
      `Eden — ${t.name}`,
      nav("Approve", true) +
        `<div class="page-head"><h1><code>${escapeHtml(t.name)}</code></h1><span \
class="muted">${escapeHtml(t.state)}</span></div>
         <p class="sub">${escapeHtml(t.when_to_use) || "No description recorded."}</p>
         ${list}${approve}`,
    );
  }

  // ── Self-serve signup: the door for actual users. ─────────────────────────
  // A visitor can read every page, but until they hold an API key they cannot
  // DO anything. This endpoint mints a workspace + key in one call, rate
  // limited per IP so abuse costs bounded resources. The key is returned ONCE;
  // only its sha256 is stored.
  if (url.pathname === "/v1/signup" && req.method === "POST") {
    const ip = signupClientAddress(req, peer);
    const RATE_LIMIT = 5;
    const WINDOW_MS = 3_600_000;
    await d.run(`CREATE TABLE IF NOT EXISTS signup_rate (ip TEXT PRIMARY KEY, hits INTEGER, window_start BIGINT)`, []);
    const row = await d.get<{ hits: number; window_start: number }>(
      `SELECT hits, window_start FROM signup_rate WHERE ip = ?`,
      [ip],
    );
    const now = Date.now();
    // A window that has run out starts again now: the UPDATE below moves window_start with it.
    const windowStart = row && now - row.window_start < WINDOW_MS ? row.window_start : now;
    const hits = row && windowStart === row.window_start ? row.hits : 0;
    if (hits >= RATE_LIMIT) {
      return Response.json(
        {
          error: "Too many workspaces created from this address this hour. Try again later.",
        },
        { status: 429 },
      );
    }
    if (row) {
      await d.run(`UPDATE signup_rate SET hits = ?, window_start = ? WHERE ip = ?`, [hits + 1, windowStart, ip]);
    } else {
      await d.run(`INSERT INTO signup_rate (ip, hits, window_start) VALUES (?, ?, ?)`, [ip, 1, now]);
    }

    let name = "";
    try {
      const parsed = (await req.json()) as { name?: unknown };
      if (typeof parsed?.name === "string") name = parsed.name.slice(0, 80);
    } catch {
      /* empty body is fine */
    }
    const wsId = `ws_${crypto.randomUUID().slice(0, 12)}`;
    // WebCrypto has no randomBytes; getRandomValues is the portable form.
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = `eden_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    await d.run(`INSERT INTO workspace (id, name) VALUES (?, ?)`, [wsId, name || `workspace-${wsId.slice(3, 9)}`]);
    await d.run(`INSERT INTO api_key (prefix, hash, workspace_id) VALUES (?, ?, ?)`, [
      token.slice(0, 12),
      hashApiKey(token),
      wsId,
    ]);
    return Response.json(
      {
        api_key: token,
        workspace_id: wsId,
        base_url: origin,
        note: "This key is shown once. Store it now.",
      },
      { headers: { "set-cookie": sessionCookie(token) } },
    );
  }

  if (url.pathname === "/v1/session" && req.method === "POST") {
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    let key = typeof parsed.value.api_key === "string" ? parsed.value.api_key.trim() : "";
    key = key.replace(/^EDEN_API_KEY=/, "");
    if (!key) return unauthorizedJson();
    const signed = await workspaceForKey(d, `Bearer ${key}`);
    if (!signed) return unauthorizedJson();
    return Response.json({ ok: true, workspace_id: signed }, { headers: { "set-cookie": sessionCookie(key) } });
  }

  if (url.pathname === "/v1/logout" && req.method === "POST") {
    const cookie = { "set-cookie": clearSessionCookie() };
    if ((req.headers.get("accept") ?? "").includes("application/json")) {
      return Response.json({ ok: true }, { headers: cookie });
    }
    return new Response(null, { status: 303, headers: { ...cookie, location: "/" } });
  }

  // Signup page.
  if (url.pathname === "/signup" && req.method === "GET") {
    const envBlock = `export OPENAI_BASE_URL=${origin.replace(/\/$/, "")}/v1
export OPENAI_API_KEY=<your provider key>
export EDEN_API_KEY=<the key above>
# Authorization is the provider key. Send the Eden key as header x-eden-api-key.`;
    const body =
      nav(wsId ? "Setup" : "Sign up", Boolean(wsId)) +
      `
<h1>Sign up</h1>
<p class="sub">Thirty seconds. The key is the account, shown once.</p>
<div id="signupPanel">
  <form id="signupForm">
    <div class="field">
      <label for="wsName">Workspace name <span class="muted">(optional)</span></label>
      <input type="text" id="wsName" name="name" placeholder="my-agent" autocomplete="organization"/>
    </div>
    <button type="submit" class="btn ship" id="signupBtn">Sign up</button>
    <p id="signupErr" class="error-text" role="status" style="margin-top:10px"></p>
  </form>
</div>
<div class="hidden" id="donePanel">
  <p class="muted" style="margin-bottom:0.75rem">Shown once. Copy it now.</p>
  <pre><code id="keyOut"></code>${copyBtn()}</pre>
  <div class="row">
    <a href="/dashboard" class="btn">Open the desk</a>
    <a href="/onboarding" class="btn ghost">Setup</a>
  </div>
  <details class="more">
    <summary>Connect the agent</summary>
    <p class="muted">Placeholders until you include the Eden key.</p>
    <pre><code id="envOut">${escapeHtml(envBlock)}</code>${copyBtn()}</pre>
    <label class="check"><input type="checkbox" id="includeKey"/> Include my Eden key in the copied env</label>
    <p id="secretNote" class="secret-note hidden">The env block now contains a secret.</p>
  </details>
</div>
<script>
(function(){
  const envTpl = ${JSON.stringify(envBlock)};
  let minted = "";
  function paintEnv(){
    const include = document.getElementById("includeKey").checked;
    document.getElementById("envOut").textContent = include && minted
      ? envTpl.replace("<the key above>", minted)
      : envTpl;
    document.getElementById("secretNote").classList.toggle("hidden", !(include && minted));
  }
  document.getElementById("includeKey").addEventListener("change", paintEnv);
  document.getElementById("signupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("signupBtn");
    btn.disabled = true; btn.textContent = "Creating…";
    document.getElementById("signupErr").textContent = "";
    try {
      const res = await fetch("/v1/signup", { method: "POST", headers: \
{"content-type":"application/json"}, body: JSON.stringify({ name: \
document.getElementById("wsName").value }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "Signup failed");
      minted = j.api_key;
      document.getElementById("signupPanel").classList.add("hidden");
      document.getElementById("donePanel").classList.remove("hidden");
      document.getElementById("keyOut").textContent = minted;
      paintEnv();
    } catch (err) {
      document.getElementById("signupErr").textContent = String(err.message || err);
      btn.disabled = false; btn.textContent = "Sign up";
    }
  });
})();
</script>`;
    return html("Eden — Sign up", body);
  }

  // Trace intake for CLI clients (`eden import`, hook flush). Accepts one
  // StretchTrace-shaped body or {traces:[...]}, adapts each event into this
  // plane's ToolEvent model, and runs the same redact+ingest pipeline as
  // /v1/ingest. Without this route, logging into the hosted deployment broke
  // every client-side recorder with a 404.
  if (url.pathname === "/v1/traces" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as {
      id?: unknown;
      complete?: unknown;
      events?: unknown;
      traces?: Array<Record<string, unknown>>;
    };
    const list: Array<Record<string, unknown>> = Array.isArray(body.traces)
      ? body.traces
      : [body as Record<string, unknown>];
    let accepted = 0;
    let batches = 0;
    for (const t of list) {
      if (!t || !Array.isArray(t.events) || !t.events.length) continue;
      batches++;
      const runId = typeof t.id === "string" && t.id ? t.id : crypto.randomUUID();
      const evs: ToolEvent[] = t.events
        .map((e: Record<string, unknown>, i: number): ToolEvent | null => {
          if (!e || typeof e.name !== "string" || !e.name) return null;
          return {
            event_id: `${runId}-${i}`,
            seq: typeof e.seq === "number" ? e.seq : i,
            name: e.name,
            args: redact((e.args ?? {}) as Record<string, unknown>) as Record<string, unknown>,
            ...(e.result !== undefined ? { result: redact(e.result) } : {}),
            ok: e.ok !== false,
            ...(typeof e.duration_ms === "number" ? { duration_ms: e.duration_ms } : {}),
            ...(typeof e.command === "string" ? { command: e.command } : {}),
          };
        })
        .filter((e): e is ToolEvent => e !== null);
      if (!evs.length) continue;
      await ingest(d, wsId, runId, evs, Boolean(t.complete));
      accepted++;
    }
    return Response.json({ ok: true, n: list.length, accepted }, { status: 202 });
  }

  if (url.pathname === "/v1/setup" && req.method === "POST") {
    // Gated on isManagedDeployment(), not on VERCEL alone. The rest of the
    // auth stack asks "is this a real deployment" and answers
    // `DATABASE_URL || VERCEL`; this asked only about Vercel, so every other
    // way of running the same code in production — Fly, Render, Docker, a box
    // on the LAN — served an unauthenticated endpoint that handed out a
    // working credential to anyone who posted to it.
    if (isManagedDeployment() && process.env.EDEN_DEV !== "1") return new Response("unauthorized", { status: 401 });
    return Response.json({ api_key: "eden_dev", base_url: origin });
  }

  if (url.pathname === "/v1/tools") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const tools = await d.all<{
      id: string;
      name: string;
      state: string;
      when_to_use: string;
      seen: string;
      steps: string;
    }>(`SELECT id, name, state, when_to_use, seen, steps FROM tool WHERE workspace_id = ? ORDER BY name`, [wsId]);
    return Response.json({
      tools: tools.map((t) => {
        const steps = jsonRows(t.steps) as Array<{ kind?: string; method?: string; command?: string }>;
        // Read-only means every step is a plain GET: transparent execution
        // may serve such programs on the agent's behalf. Anything else —
        // POSTs, runner commands, island glue — stays explicit-only until a
        // human opts that program in.
        const read_only =
          steps.length > 0 && steps.every((s) => s.kind === "cloud_http" && (s.method || "GET") === "GET");
        return {
          id: t.id,
          name: t.name,
          state: t.state,
          when_to_use: t.when_to_use,
          seen: jsonRows(t.seen),
          has_playback: steps.some((s) => Boolean((s as { url?: string })?.url)),
          read_only,
        };
      }),
    });
  }

  if (url.pathname === "/v1/ingest" && req.method === "POST") {
    if (!wsId) return unauthorizedJson();
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { run_id?: unknown; events?: unknown; stretch_end?: unknown };
    if (typeof body.run_id !== "string" || !body.run_id) {
      return Response.json({ error: "run_id must be a non-empty string" }, { status: 400 });
    }
    if (!Array.isArray(body.events)) {
      return Response.json({ error: "events must be an array" }, { status: 400 });
    }
    const bad = body.events.findIndex((e) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) return true;
      const rec = e as { event_id?: unknown; name?: unknown };
      return typeof rec.event_id !== "string" && typeof rec.name !== "string";
    });
    if (bad >= 0) {
      return Response.json(
        { error: `events[${bad}] must be an object with a string event_id or name` },
        { status: 400 },
      );
    }
    const cleanEvents = (body.events as ToolEvent[]).map((e, i) => ({
      ...e,
      event_id: typeof e.event_id === "string" && e.event_id ? e.event_id : `${body.run_id}-${i}`,
      ...(e.args !== undefined ? { args: redact(e.args) as Record<string, unknown> } : {}),
      ...(e.result !== undefined ? { result: redact(e.result) } : {}),
      ...(typeof (e as { command?: string }).command === "string"
        ? { command: redact((e as { command: string }).command) }
        : {}),
    })) as ToolEvent[];
    const stretchEnd = Boolean(body.stretch_end);
    const oneShot = !stretchEnd && cleanEvents.length >= 2;
    const fallback = { drafts: 0, islands: 0, stored: cleanEvents.length };
    let result = fallback;
    try {
      result = await Promise.race([
        ingest(d, wsId, body.run_id, cleanEvents, stretchEnd || oneShot),
        new Promise<typeof fallback>((resolve) => setTimeout(() => resolve(fallback), 8_000)),
      ]);
    } catch {
      result = fallback;
    }
    const sealed = stretchEnd || oneShot;
    const accepted = sealed && (cleanEvents.length > 0 || Number(result.stored) > 0) ? 1 : 0;
    return Response.json(
      { ok: true, accepted, drafts: result.drafts ?? 0, islands: result.islands ?? 0 },
      { status: 202, headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) } },
    );
  }

  // Bulk import from observability exports. Accepts raw file content, sniffs
  // the format (LangSmith / OTel / OpenAI chat / generic JSONL), normalizes
  // via adapters, and feeds each trace group through the standard ingest
  // pipeline. This is the web-UI counterpart to cold-start elimination.
  if (url.pathname === "/v1/import" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { content?: unknown };
    if (typeof body.content !== "string" || !body.content.trim()) {
      return Response.json({ error: "content must be a non-empty string" }, { status: 400 });
    }
    const detected = detectAndParse(body.content);
    if (!detected) {
      return Response.json({ error: "Unrecognized trace format" }, { status: 400 });
    }
    let totalTraces = 0;
    let totalEvents = 0;
    const errors: string[] = [];
    for (const [traceId, events] of detected.traces) {
      if (events.length < 2) continue;
      try {
        const result = await ingest(d, wsId, `${detected.format}-${traceId}`, events, true);
        totalTraces++;
        totalEvents += events.length;
        void result;
      } catch (err) {
        errors.push(`${traceId}: ${err}`);
      }
    }
    return Response.json({ ok: true, format: detected.format, traces: totalTraces, events: totalEvents, errors });
  }

  if (url.pathname === "/v1/live-tools") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const tools = await d.all<{ name: string; seen: string; required_k: number | null; steps: string }>(
      `SELECT name, seen, required_k, steps FROM tool WHERE workspace_id = ? AND state = 'on'`,
      [wsId],
    );
    const knock = await d.get<{ tool_id: string }>(
      `SELECT tool_id FROM knock WHERE workspace_id = ? AND resolution IS NULL LIMIT 1`,
      [wsId],
    );
    return Response.json({
      tools: tools.map((t) => ({
        name: t.name,
        seen: jsonRows(t.seen) as string[],
        required_k: Number(t.required_k) || 2,
        urls: (jsonRows(t.steps) as Array<{ url?: string }>).map((s) => s?.url).filter(Boolean) as string[],
      })),
      knock: knock ? { message: `draft ${knock.tool_id}`, tool_id: knock.tool_id } : null,
    });
  }

  // The honest savings ledger: one per-workspace aggregate where every number
  // is backed by evidence or explicitly "not measured". Same Bearer gate as
  // every sibling /v1 read, and no-store — a ledger is evidence, not a
  // cacheable opinion.
  if (url.pathname === "/v1/ledger") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const ledger = await buildLedger(d, wsId);
    return Response.json(ledger, { headers: { "cache-control": "no-store" } });
  }

  if (url.pathname === "/v1/knock/reject" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const k = await d.get<{ id: string; tool_id: string }>(
      `SELECT id, tool_id FROM knock WHERE workspace_id = ? AND resolution IS NULL LIMIT 1`,
      [wsId],
    );
    if (k) {
      // Scoped like its siblings. The id is itself fetched through a scoped query,
      // so there is no live cross-tenant path today — but an unscoped DELETE on the
      // primary tenant table should not depend on that staying true.
      const tool = await d.get<{ fingerprint: string }>(
        `SELECT fingerprint FROM tool WHERE id = ? AND workspace_id = ?`,
        [k.tool_id, wsId],
      );
      await d.run(`UPDATE knock SET resolution = 'reject' WHERE id = ?`, [k.id]);
      if (tool)
        await d.run(`INSERT OR IGNORE INTO ignore_fp (workspace_id, fingerprint) VALUES (?, ?)`, [
          wsId,
          tool.fingerprint,
        ]);
      await d.run(`DELETE FROM tool WHERE id = ? AND workspace_id = ?`, [k.tool_id, wsId]);
    }
    return Response.json({ ok: true });
  }

  const approve = url.pathname.match(/^\/v1\/tools\/([^/]+)\/approve$/);
  if (approve && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    // Existence first: the UPDATE below is scoped and simply affects zero rows
    // for an id that is not this workspace's, which used to be answered with
    // the same success redirect as a real approval.
    const tool = await d.get<{ id: string }>(`SELECT id FROM tool WHERE id = ? AND workspace_id = ?`, [
      approve[1],
      wsId,
    ]);
    if (!tool) {
      if (req.headers.get("accept")?.includes("json")) return Response.json({ error: "not found" }, { status: 404 });
      return new Response("not found", { status: 404 });
    }
    // The savings ledger reads tool.manifest, and this route is the only place
    // a tool flips to 'on' — but the shadow manifest itself lives in the
    // control plane's gate run, which is not reachable from here through any
    // existing helper. Rather than fabricate numbers, the route accepts the
    // candidate's manifest as an optional JSON body field, validates it
    // against the ShadowManifest shape (sanitizeManifest rejects unknown
    // fields and mistyped values), and persists it verbatim. A form approval
    // (urlencoded body) carries no manifest and approves exactly as before;
    // an invalid one is refused rather than half-stored.
    let manifestJson: string | null = null;
    if ((req.headers.get("content-type") || "").includes("application/json")) {
      const parsed = readJsonObject(await readJson(req));
      if (!parsed.ok) return parsed.res;
      if (parsed.value.manifest !== undefined && parsed.value.manifest !== null) {
        const m = sanitizeManifest(parsed.value.manifest);
        if (!m.ok) {
          console.error(`[eden] approve ${approve[1]}: refusing bad manifest: ${m.error}`);
          return Response.json({ error: `invalid manifest: ${m.error}` }, { status: 400 });
        }
        manifestJson = JSON.stringify(m.value);
      }
    }
    await ensureLedgerSchema(d);
    if (manifestJson) {
      await d.run(`UPDATE tool SET state = 'on', published = 1, manifest = ? WHERE id = ? AND workspace_id = ?`, [
        manifestJson,
        approve[1],
        wsId,
      ]);
    } else {
      await d.run(`UPDATE tool SET state = 'on', published = 1 WHERE id = ? AND workspace_id = ?`, [approve[1], wsId]);
    }
    if (req.headers.get("accept")?.includes("json")) return Response.json({ ok: true });
    // Encoded: the raw segment came off the request path, and an id carrying
    // `?` or `#` would otherwise rewrite which URL the form lands on.
    const id = approve[1]!;
    return Response.redirect(`${origin}/workshop/${encodeURIComponent(id)}`, 303);
  }

  if (url.pathname === "/v1/play" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { name?: unknown; issue?: unknown; issues?: unknown; ids?: unknown; dryRun?: unknown };
    if (typeof body.name !== "string" || !body.name) {
      return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const tool = await d.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE name = ? AND state = 'on' AND workspace_id = ?`,
      [body.name, wsId],
    );
    if (!tool) return new Response("not found", { status: 404 });
    let receipt;
    try {
      receipt = await playTool(
        d,
        tool,
        {
          issue: str(body.issue),
          issues: str(body.issues) || str(body.ids) || str(body.issue),
          ids: str(body.ids) || str(body.issues) || str(body.issue),
          origin,
        },
        // Dry-run rehearsal (G9): mutating steps are resolved and reported,
        // not executed. Reads run for real so templates and binds are
        // exercised against live data.
        { dryRun: body.dryRun === true },
      );
    } catch (err) {
      // Corrupt stored steps throw inside playback. That is a data problem on
      // our side — answer with a clean 500-shaped JSON body rather than an
      // unhandled exception and a stack trace.
      return Response.json({ error: `tool execution failed: ${(err as Error).message}` }, { status: 500 });
    }
    return Response.json(receipt);
  }

  if ((url.pathname === "/v1/webhook" || url.pathname === "/v1/hooks/invalidate") && req.method === "POST") {
    // Shared-secret invalidation. Own auth (EDEN_WEBHOOK_SECRET); missing or
    // wrong secret is 401/403 and keys stay. Empty keys are a no-op, not a wipe.
    // Never pauses the live tool — drop is cache-only.
    return handleWebhook(d, req);
  }

  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    if (!wsId) return unauthorizedJson();
    // Whose model key pays (#88, #91): always the caller's own, forwarded as itself. The site's
    // OPENAI_API_KEY is never spent on chat, on a deployment or a laptop. Anyone can mint a key at
    // /v1/signup, and /v1/setup hands out eden_dev, so no Eden key shows who should pay. Being
    // non-empty, ownKey also keeps handleChatCompletions from falling back to OPENAI_API_KEY.
    const ownKey = callerProviderKey(req);
    if (!ownKey) return providerKeyRequired();
    let programs: ReturnType<typeof toolRowToProgram>[] = [];
    try {
      programs = (await liveOnTools(d, wsId)).map(toolRowToProgram);
    } catch {
      programs = [];
    }
    return handleChatCompletions(req, {
      state: siteWrapState,
      upstream: process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
      upstreamKey: ownKey,
      // The process memory store would be shared by every workspace here, and on a dev host by
      // every caller that gets into ws_local. The site has no operator it could belong to (#89).
      memory: false,
      getPrograms: () => programs,
      play: async (name, args) => {
        const tool = await findOnTool(d, wsId, name);
        if (!tool || !toolHasPlayback(tool)) return null;
        const strArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(args)) {
          if (v == null) continue;
          strArgs[k] = typeof v === "string" ? v : String(v);
        }
        const played = await wrapPlay(d, wsId, tool, strArgs, origin);
        return played.facts;
      },
    });
  }

  if (url.pathname === "/v1/wrap" && req.method === "POST") {
    if (!wsId) return unauthorizedJson();
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as {
      name?: unknown;
      args?: unknown;
      input?: unknown;
      arguments?: unknown;
      run_id?: unknown;
    };
    if (typeof body.name !== "string" || !body.name) {
      return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    let rawArgs: unknown = body.args ?? body.input ?? body.arguments;
    if (typeof rawArgs === "string") {
      try {
        rawArgs = JSON.parse(rawArgs) as unknown;
      } catch {
        return Response.json({ error: "args must be an object" }, { status: 400 });
      }
    }
    if (rawArgs != null && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
      return Response.json({ error: "args must be an object" }, { status: 400 });
    }
    if (body.run_id != null && typeof body.run_id !== "string") {
      return Response.json({ error: "run_id must be a string" }, { status: 400 });
    }
    const tool = await findOnTool(d, wsId, body.name);
    const proto = { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) };
    if (!tool || !toolHasPlayback(tool)) return Response.json({ action: "original" }, { headers: proto });
    const runId = typeof body.run_id === "string" ? body.run_id : undefined;
    let played;
    try {
      played = await wrapPlay(d, wsId, tool, (rawArgs ?? {}) as Record<string, string>, origin, runId);
    } catch {
      // Fail-open: a broken play never 500s the agent. Same contract as local wrap.
      return Response.json({ action: "original" }, { headers: proto });
    }
    return Response.json(played, { headers: proto });
  }

  if (
    (url.pathname === "/v1" || url.pathname === "/v1/" || url.pathname === "/v1/openapi.json") &&
    req.method === "GET"
  ) {
    if (!wsId) return unauthorizedJson();
    return Response.json(AGENT_OPENAPI, {
      headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) },
    });
  }

  if (url.pathname === "/v1/dispatch" && req.method === "POST") {
    if (!wsId) return unauthorizedJson();
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    let tools: unknown[] = [];
    try {
      tools = wrapDispatchResult(await liveOnTools(d, wsId), parsed.value as Record<string, unknown>).tools;
    } catch {
      tools = [];
    }
    if (tools.length > 1) tools = tools.slice(0, 1);
    return Response.json({ tools }, { headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) } });
  }

  if (url.pathname === "/mcp") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    // No server→client push channel exists, so a GET would have to answer
    // 200 text/event-stream with a stream that never speaks MCP — clients
    // waiting on it hang or misparse the body as a malformed event. The
    // Streamable HTTP transport says such a server answers 405.
    if (req.method === "GET") {
      return new Response("method not allowed; this server accepts JSON-RPC over POST only", { status: 405 });
    }
    // Streamable HTTP: DELETE terminates the session. This server keeps no
    // per-session state, so there is nothing to refuse and nothing to tear
    // down — answering 202 (the same accepted-but-empty shape as a
    // notification) lets a client close its session cleanly instead of
    // parsing a non-JSON 404 as a protocol error.
    if (req.method === "DELETE") {
      return new Response(null, { status: 202 });
    }
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    const rpc = parsed.value as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    if (typeof rpc.method !== "string") {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: method must be a string" } },
        { status: 400 },
      );
    }
    const out = await handleMcp(d, wsId, rpc, origin);
    if (out === null) return new Response(null, { status: 202 });
    return Response.json(out);
  }

  if (url.pathname.startsWith("/v1/") || url.pathname === "/v1") {
    if (!wsId) return unauthorizedJson();
    return Response.json(
      { error: "not found" },
      { status: 404, headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) } },
    );
  }
  return new Response("not found", { status: 404 });
}
