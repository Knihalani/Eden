import { openDb, workspaceForKey, isManagedDeployment, type EdenDb } from "./db";
import { ingest } from "./cluster";
import { handleMcp } from "./mcp";
import { playTool } from "./playback";
import { handleForge } from "./forge";
import { escapeHtml, layout } from "./html";
import { findOnTool, wrapPlay, toolHasPlayback } from "./wrap";
import { buildLedger, ensureLedgerSchema, sanitizeManifest, type LedgerFigure } from "./ledger";
import type { ToolEvent } from "@eden/core";

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
  const existing = await d.get<{ id: string }>(`SELECT id FROM tool WHERE name = 'fetch_issue_bundle' AND workspace_id = 'ws_local'`);
  const steps = [
    { id: "s1", kind: "cloud_http", name: "issue", commute: true, url: "{origin}/forge/repos/acme/app/issues/{issue}" },
    { id: "s2", kind: "cloud_http", name: "comments", commute: true, url: "{origin}/forge/repos/acme/app/issues/{issue}/comments" },
    { id: "s3", kind: "cloud_http", name: "pull", commute: true, url: "{origin}/forge/repos/acme/app/pulls/{issue}" },
    { id: "s4", kind: "cloud_http", name: "reviews", commute: true, url: "{origin}/forge/repos/acme/app/pulls/{issue}/reviews" },
    { id: "s5", kind: "cloud_http", name: "status", commute: true, url: "{origin}/forge/repos/acme/app/commits/abc{issue}/status" },
    { id: "s6", kind: "cloud_http", name: "runs", commute: true, url: "{origin}/forge/repos/acme/app/actions/runs?pr={issue}" },
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
    await d.run(`UPDATE tool SET steps = ?, when_to_use = ?, seen = ?, required_k = 2 WHERE id = ?`, [
      JSON.stringify(steps),
      when,
      seen,
      existing.id,
    ]);
    return;
  }
  await d.run(
    `INSERT INTO tool (id, workspace_id, name, when_to_use, state, steps, seen, fingerprint, required_k, published)
     VALUES (?, 'ws_local', 'fetch_issue_bundle', ?, 'on', ?, ?, 'seed_bundle', 2, 0)`,
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
function allowedHostNames(): Set<string> {
  const hosts = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);
  const candidates = [process.env.EDEN_PUBLIC_URL, process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ""];
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
  const host = raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
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

export async function handleFetch(req: Request): Promise<Response> {
  // Same predicate as authentication uses: auto-approve must be impossible
  // anywhere a key is actually required, not only on Vercel.
  if (isManagedDeployment() && process.env.EDEN_DEV !== "1") {
    delete process.env.EDEN_AUTO_APPROVE;
  }
  const d = await db();
  const url = new URL(req.url);
  const origin = process.env.EDEN_PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${url.port || PORT}`);

  const forge = handleForge(url);
  if (forge) return forge;

  if (url.pathname === "/health") return Response.json({ ok: true });

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

  const wsId = await workspaceForKey(d, req.headers.get("authorization"));

  if (url.pathname === "/dashboard" || url.pathname === "/") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
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
      [monthStart.getTime(), monthStart.getTime(), monthStart.getTime(), monthStart.getTime(), monthStart.getTime(), wsId],
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
    const drafts = (await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM tool WHERE workspace_id = ? AND state = 'draft'`, [wsId])) || { c: 0 };
    const on = (await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM tool WHERE workspace_id = ? AND state = 'on'`, [wsId])) || { c: 0 };
    // The honest savings ledger, summarized in the same spare style. Absent
    // evidence renders as "not measured" — the dashboard must not say more
    // than the receipts behind it do.
    const ledger = await buildLedger(d, wsId);
    const lines = [
      `<p class="muted">Eden is watching the agent work. Same stretch twice → a draft in Workshop. Approve only here — a key never turns a tool On.</p>`,
      `<div class="row">Drafts waiting <strong>${drafts.c}</strong></div>`,
      `<div class="row">Tools on <strong>${on.c}</strong></div>`,
      `<div class="row">Ledger <a href="/v1/ledger">/v1/ledger</a> · ${ledger.runs} runs · ${ledger.live} live</div>`,
      `<div class="row">Tokens saved <strong>${escapeHtml(savingsWord(ledger.tokens_saved_mean))}</strong></div>`,
      `<div class="row">Time saved <strong>${escapeHtml(savingsWord(ledger.time_saved_ms_mean))}</strong></div>`,
    ];
    if (usage.runs > 0) {
      lines.push(
        `<div class="row">This month: ${(month.server_ms / 1000).toFixed(1)}s server compute · ${month.steps} steps · ${(month.raw_bytes / 1e6).toFixed(2)}MB raw → ${(month.densified_bytes / 1000).toFixed(0)}KB to the model · ${month.runs} runs</div>`,
      );
    }
    return html("Dashboard", `<h1>Dashboard</h1>${lines.join("")}`);
  }

  if (url.pathname === "/workshop") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const tools = await d.all<{ id: string; name: string; state: string; uses_count: number }>(
      `SELECT id, name, state, uses_count FROM tool WHERE workspace_id = ? ORDER BY CASE state WHEN 'draft' THEN 0 WHEN 'on' THEN 1 ELSE 2 END, name`,
      [wsId],
    );
    const rows = tools
      .map((t) => `<div class="row"><a href="/workshop/${t.id}"><code>${escapeHtml(t.name)}</code></a> · ${escapeHtml(t.state)} · ${t.uses_count} uses</div>`)
      .join("");
    return html("Workshop", `<h1>Workshop</h1><p class="muted">Approve only on this page. A key never turns a tool On.</p>${rows || `<p class="muted">No drafts yet.</p>`}`);
  }

  const ws = url.pathname.match(/^\/workshop\/([^/]+)$/);
  if (ws && req.method === "GET") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const t = await d.get<{ id: string; name: string; when_to_use: string; state: string; steps: string; published?: number }>(
      `SELECT id, name, when_to_use, state, steps, published FROM tool WHERE id = ? AND workspace_id = ?`,
      [ws[1], wsId],
    );
    if (!t) return new Response("not found", { status: 404 });
    const steps = jsonRows(t.steps) as Array<{ id: string; name: string; kind: string; url?: string }>;
    const list = steps
      .map((s) => `<div class="row"><code>${escapeHtml(String(s.name))}</code> · ${escapeHtml(String(s.kind))}${s.url ? ` · ${escapeHtml(String(s.url))}` : ""}</div>`)
      .join("");
    const approve =
      t.state !== "on"
        ? `<form method="post" action="/v1/tools/${t.id}/approve"><button>Approve</button></form>`
        : t.published
          ? `<p class="muted">Published on MCP as <code>${escapeHtml(t.name)}</code>.</p>`
          : `<p class="muted">On for this workspace. Publish to list it on MCP.</p>
             <form method="post" action="/v1/tools/${t.id}/approve"><button>Publish to MCP</button></form>`;
    return html(`Tool ${t.name}`, `<h1>${escapeHtml(t.name)}</h1><p class="muted">${escapeHtml(t.when_to_use)}</p>${list}${approve}`);
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
      tools: tools.map((t) => ({
        id: t.id,
        name: t.name,
        state: t.state,
        when_to_use: t.when_to_use,
        seen: jsonRows(t.seen),
        has_playback: (jsonRows(t.steps) as Array<{ url?: string }>).some((s) => Boolean(s?.url)),
      })),
    });
  }

  if (url.pathname === "/v1/ingest" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { run_id?: unknown; events?: unknown; stretch_end?: unknown };
    // The handler below maps over `events` and binds every field into SQL, so
    // shape errors here would otherwise surface as a 500 after some rows of
    // the batch had already committed.
    if (typeof body.run_id !== "string" || !body.run_id) {
      return Response.json({ error: "run_id must be a non-empty string" }, { status: 400 });
    }
    if (!Array.isArray(body.events)) {
      return Response.json({ error: "events must be an array" }, { status: 400 });
    }
    const bad = body.events.findIndex(
      (e) => !e || typeof e !== "object" || typeof (e as ToolEvent).event_id !== "string",
    );
    if (bad >= 0) {
      return Response.json({ error: `events[${bad}] must be an object with a string event_id` }, { status: 400 });
    }    const result = await ingest(
      d,
      wsId,
      body.run_id,
      body.events as ToolEvent[],
      Boolean(body.stretch_end),
    );
    return Response.json(result, { status: 202 });
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
      if (tool) await d.run(`INSERT OR IGNORE INTO ignore_fp (workspace_id, fingerprint) VALUES (?, ?)`, [wsId, tool.fingerprint]);
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
    const body = parsed.value as { name?: unknown; issue?: unknown; issues?: unknown; ids?: unknown };
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
      receipt = await playTool(d, tool, {
        issue: str(body.issue),
        issues: str(body.issues) || str(body.ids) || str(body.issue),
        ids: str(body.ids) || str(body.issues) || str(body.issue),
        origin,
      });
    } catch (err) {
      // Corrupt stored steps throw inside playback. That is a data problem on
      // our side — answer with a clean 500-shaped JSON body rather than an
      // unhandled exception and a stack trace.
      return Response.json({ error: `tool execution failed: ${(err as Error).message}` }, { status: 500 });
    }
    return Response.json(receipt);
  }

  if (url.pathname === "/v1/wrap" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const parsed = readJsonObject(await readJson(req));
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { name?: unknown; args?: unknown; run_id?: unknown };
    if (typeof body.name !== "string" || !body.name) {
      return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    if (body.args != null && (typeof body.args !== "object" || Array.isArray(body.args))) {
      return Response.json({ error: "args must be an object" }, { status: 400 });
    }
    if (body.run_id != null && typeof body.run_id !== "string") {
      return Response.json({ error: "run_id must be a string" }, { status: 400 });
    }
    const tool = await findOnTool(d, wsId, body.name);
    if (!tool || !toolHasPlayback(tool)) return Response.json({ action: "original" });
    const runId = typeof body.run_id === "string" ? body.run_id : undefined;
    let played;
    try {
      played = await wrapPlay(d, wsId, tool, (body.args ?? {}) as Record<string, string>, origin, runId);
    } catch (err) {
      return Response.json({ error: `tool execution failed: ${(err as Error).message}` }, { status: 500 });
    }
    return Response.json(played);
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

  return new Response("not found", { status: 404 });
}

