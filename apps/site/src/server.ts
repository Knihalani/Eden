import { openDb, workspaceForKey, isManagedDeployment, hashApiKey, type EdenDb } from "./db";
import { ingest } from "./cluster";
import { handleMcp } from "./mcp";
import { playTool } from "./playback";
import { handleForge } from "./forge";
import { copyBtn, escapeHtml, layout, nav } from "./html";
import { findOnTool, wrapPlay, toolHasPlayback } from "./wrap";
import { buildLedger, ensureLedgerSchema, sanitizeManifest, type LedgerFigure } from "./ledger";
import { detectAndParse } from "@eden/core";
import { protocolCheck, EDEN_PROTOCOL_VERSION, PROTOCOL_HEADER, redact } from "@eden/ir";
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

  if (url.pathname === "/health") {
    return Response.json(
      { ok: true, protocol: EDEN_PROTOCOL_VERSION },
      { headers: { [PROTOCOL_HEADER]: String(EDEN_PROTOCOL_VERSION) } },
    );
  }

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

  const wsId = await workspaceForKey(d, req.headers.get("authorization"));

/**
 * Auth gate for HTML pages: a signed-out browser is sent to onboarding
 * instead of a bare 401 body it cannot act on. API clients (no text/html in
 * Accept, or non-GET) still get the machine-readable 401.
 */
function pageAuth(req: Request, wsId: string | null): Response | null {
  if (wsId) return null;
  const wantsHtml =
    req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
  if (!wantsHtml) return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  return new Response(null, {
    status: 302,
    headers: { location: `/onboarding?next=${encodeURIComponent(url.pathname)}` },
  });
}

  if (url.pathname === "/onboarding") {
    if (!wsId) {
      // On a managed deployment there is no dev mode to continue into — the
      // only door is a real API key. On a laptop, dev mode is the fastest path.
      const noDevMode = isManagedDeployment() && process.env.EDEN_DEV !== "1";
      return html("Eden", `<div class="container" style="max-width:520px">
<h1>Welcome to Eden</h1>
<p class="sub">Repeated work becomes one call — measured, approved by you, and fail-safe by construction.</p>
<div class="panel" style="padding:24px">
  <h2>Sign in to your workspace</h2>
  <p class="muted" style="margin-bottom:12px">Paste the API key from your Eden config${noDevMode ? "." : ", or continue in dev mode for local testing."}</p>
  <input type="text" id="apiKey" placeholder="EDEN_API_KEY=…" style="margin-bottom:12px"/>
  ${noDevMode ? `<p class="muted" style="margin-bottom:12px">No key yet? <a href="/signup" style="text-decoration:underline">Create a workspace — it takes thirty seconds.</a></p><p class="muted">Running locally? Start <code>eden wrap</code> and open its dashboard instead.</p>` : `<button class="btn" onclick="location.href='/onboarding?dev=1'">Continue in dev mode →</button>`}
</div></div>`);
    }
    const tc = Number((await d.get<{ c: number }>(`SELECT COUNT(DISTINCT run_id) as c FROM stretch WHERE workspace_id = ?`, [wsId]) ?? {c:0}).c);
    const cc = Number((await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM cluster WHERE workspace_id = ? AND count >= 2`, [wsId]) ?? {c:0}).c);
    const lc = Number((await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM tool WHERE workspace_id = ? AND state = 'on'`, [wsId]) ?? {c:0}).c);
    const st = (n:number,done:boolean,cur:boolean,title:string,body:string)=>`<div class="step ${done?"done":cur?"current":"pending"}"><div class="step-head"><span class="num">${done?"✓":n}</span><span class="step-title">${title}</span><span class="badge ${done?"ok":cur?"action":"todo"}">${done?"Done":cur?"Do this":"Waiting"}</span></div><div style="padding-left:34px">${body}</div></div>`;
    const setupPrompt = [
      "OPENAI_BASE_URL=http://127.0.0.1:8788/v1",
      "OPENAI_API_KEY=<your provider key — Eden forwards it upstream>",
    ].join("\n");
    return html("Eden — Setup", nav("Setup")
      + `<h1>Set up in three steps</h1><p class="sub">Point your agent at Eden, let it work normally, approve what Eden compiles. Nothing about your agent changes until you approve.</p>`
      + st(1,true,false,"Connect your agent",`
        <p style="margin-bottom:6px"><strong>Claude Code</strong> — run <code>eden init</code>. It installs recording hooks and wires up MCP.</p>
        <p style="margin-bottom:6px"><strong>OpenAI-compatible agent or SDK</strong> — set one environment variable:</p>
        <pre><code>${escapeHtml(setupPrompt)}</code>${copyBtn()}</pre>
        <p class="muted">That's the whole integration. Your requests flow through Eden to your provider; Eden records the tool-call patterns it sees.</p>`)
      + st(2,tc>0,tc===0,"Let your agent work — or import past traces",tc>0?`<p class="success">✓ ${tc} run${tc===1?"":"s"} recorded so far. The more repeats, the faster patterns compile.</p>`:`
        <p><strong>Easiest:</strong> just use your agent as usual. After two runs of the same workflow, a compiled draft appears.</p>
        <p><strong>No time to wait?</strong> Import history you already have (LangSmith, OpenTelemetry, OpenAI logs, JSONL):</p>
        <a href="/import" class="btn secondary" style="margin-top:8px;display:inline-block">Import existing traces →</a>`)
      + st(3,cc>0,cc===0&&tc>0,"Approve compiled tools",cc>0?`<p class="success">✓ ${cc} workflow pattern${cc===1?"":"s"} ready for review. Nothing goes live until you approve it.</p><a href="/workshop" class="btn" style="margin-top:8px;display:inline-block">Review & approve →</a>`:`<p class="muted">When a workflow repeats enough times, its draft shows up under <strong>Approve</strong>. You see exactly what will run before anything goes live.</p>`)
      + `<h2 style="margin-top:32px;margin-bottom:4px">What you get — and what it costs</h2>
         <div class="panel good"><h2>The upside</h2>
           <ul>
             <li><strong>Fewer LLM calls per repeated workflow</strong> — a stretch that took N calls becomes one compiled tool invocation.</li>
             <li><strong>Lower latency and spend</strong> on everything your agent does more than once.</li>
             <li><strong>Steps can't be skipped</strong> — a compiled tool runs the whole recorded sequence, checks included.</li>
             <li><strong>Honest numbers</strong> — savings show only when receipts back them; otherwise the dashboard says "not measured".</li>
           </ul>
         </div>
         <div class="panel warn"><h2>The trade-offs</h2>
           <ul>
             <li><strong>Compiled tools are only as general as their witnesses.</strong> Inputs outside the observed range are refused and fall back to your agent's normal path — safe, but no savings there.</li>
             <li><strong>A mid-run failure on a mutating workflow returns a structured error instead of re-running raw</strong>, so a write is never duplicated — but that one call saves nothing.</li>
             <li><strong>Recording adds a small local overhead</strong> per tool call (writes are batched and off the critical path).</li>
             <li><strong>Hard guardrails are opt-in.</strong> By default Eden observes and steers but never halts; turn on enforcement if you want runaway-loop caps at the price of possible refusals.</li>
           </ul>
         </div>
         <div class="panel safe"><h2>What Eden will never do</h2>
           <ul>
             <li>Never block, halt, or fail a call because Eden itself broke — every Eden failure falls back to passing your traffic through untouched.</li>
             <li>Never change what your agent does without your approval — compiled tools go live only via the Approve page, by a human.</li>
             <li>Never re-execute a write automatically after a partial compiled run.</li>
             <li>Never report a savings number it didn't measure.</li>
           </ul>
         </div>`
    );
  }


  // Trace import page — cold-start elimination via observability exports.
  if (url.pathname === "/import") {
    const denied = pageAuth(req, wsId);
    if (denied) return denied;
    if (!wsId) return new Response("unauthorized", { status: 401 }); // unreachable; narrows for TS
    const body = nav("Import") + `
<h1>Import existing traces</h1>
<p class="sub">Already have agent history in LangSmith, OpenTelemetry, or plain JSONL? Paste it below and Eden will mine it for repeatable workflows — no waiting for fresh runs.</p>
<div class="panel">
<form id="importForm">
  <textarea id="traceContent" rows="12" placeholder='Paste a LangSmith / OTel / OpenAI / JSONL export here…'></textarea>
  <div style="margin-top:10px;display:flex;align-items:center;gap:12px">
    <button type="submit" class="btn">Import & analyze</button>
    <span id="status" class="muted">Format is auto-detected.</span>
  </div>
</form></div>
<div id="results"></div>
<script>
document.getElementById("importForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = document.getElementById("traceContent").value;
  const status = document.getElementById("status");
  const results = document.getElementById("results");
  if (!content.trim()) { status.textContent = "Paste some trace data first."; return; }
  status.textContent = "Importing…";
  try {
    const res = await fetch("/v1/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const j = await res.json();
    if (res.ok) {
      status.innerHTML = '<span class="success">✓ Imported</span>';
      results.innerHTML = \`
        <div class="panel good"><h2>Import complete</h2>
        <div class="stat-row">
          <div class="stat"><div class="stat-val">\${j.traces}</div><div class="stat-label">Traces imported</div></div>
          <div class="stat"><div class="stat-val">\${j.events}</div><div class="stat-label">Tool calls captured</div></div>
          <div class="stat"><div class="stat-val dim">\${j.format}</div><div class="stat-label">Detected format</div></div>
        </div>
        <a href="/onboarding" class="btn">Continue setup →</a></div>\`;
    } else {
      status.innerHTML = '<span class="error-text">✗ Import failed</span>';
      results.innerHTML = \`<div class="panel warn"><p>\${j.error || "Could not read that data."}</p><p class="muted">Try exporting as JSONL — one run per line, with tool name, arguments, and result.</p></div>\`;
    }
  } catch (err) {
    status.innerHTML = '<span class="error-text">✗ Import failed</span>';
    results.textContent = String(err);
  }
});
</script>`;
    return html("Import traces", nav("Import") + body);
  }

  // The public front door: a proper landing for visitors, dashboard for users.
  if (url.pathname === "/" && !wsId) {
    const body = nav("") + `
<div style="padding:72px 0 32px;text-align:center">
  <h1 style="font-size:36px;line-height:1.18;max-width:700px;margin:0 auto">The second time your agent does something,<br/>it should cost <span style="color:#c23434">less</span>.</h1>
  <p class="sub" style="max-width:520px;margin:22px auto 30px;font-size:15px">Eden sits beside your agent and quietly collapses its repeated work into single calls. Measured. Approved by you. And it can never take your agent down.</p>
  <a href="/signup" class="btn" style="font-size:15px;padding:12px 24px">Get your API key</a>
  <p class="muted" style="margin-top:12px"><a href="https://github.com/Knihalani/Eden" style="text-decoration:underline">Source</a></p>
</div>
<div class="stat-row" style="max-width:720px;margin:0 auto 36px">
  <div class="stat" style="text-align:center"><div class="stat-val">8×</div><div class="stat-label">fewer model calls</div></div>
  <div class="stat" style="text-align:center"><div class="stat-val">7.7×</div><div class="stat-label">faster</div></div>
  <div class="stat" style="text-align:center"><div class="stat-val">−84%</div><div class="stat-label">loop wall time</div></div>
  <div class="stat" style="text-align:center"><div class="stat-val">−84%</div><div class="stat-label">runaway spend</div></div>
</div>
<div class="stat-row" style="max-width:760px">
  <div class="stat"><div style="font-weight:600;margin-bottom:8px">It pays attention.</div><p class="muted">Work your agent has done before starts finishing in one call instead of a dozen.</p></div>
  <div class="stat"><div style="font-weight:600;margin-bottom:8px">You decide.</div><p class="muted">Nothing changes until you approve it. One screen. Plain language. Reversible.</p></div>
  <div class="stat"><div style="font-weight:600;margin-bottom:8px">It behaves.</div><p class="muted">If Eden is ever wrong, slow, or broken, your agent keeps working exactly as it did before. Pinned by tests.</p></div>
</div>
<p class="muted" style="text-align:center;margin-top:26px;font-size:13px">Every number above comes from a paired benchmark that must win or it does not ship.</p>
<p style="text-align:center;margin-top:20px"><a href="/signup" class="btn">Create your workspace</a></p>`;
    return html("Eden", body);
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
    const stat = (val: string, label: string, dim = false) =>
      `<div class="stat"><div class="stat-val${dim ? " dim" : ""}">${escapeHtml(val)}</div><div class="stat-label">${label}</div></div>`;
    const activity = recent.length
      ? `<h2 style="margin-top:28px">Recent compiled runs</h2>
         <table class="activity">${recent
           .map(
             (r) =>
               `<tr><td>${escapeHtml(r.name)}</td><td>${r.steps_ok}/${r.steps_attempted} steps</td><td class="num-cell">${r.server_ms} ms</td><td class="num-cell">${fmtWhen(Number(r.created_at))}</td></tr>`,
           )
           .join("")}</table>`
      : `<p class="muted" style="margin-top:28px">No compiled runs yet. Once you approve a tool and your agent uses it, each run lands here.</p>`;
    const body = nav("Dashboard")
      + `<h1>Dashboard</h1>
<p class="sub">Eden is watching the agent work. Same stretch twice → a draft under Approve. Nothing goes live until you approve it.</p>
<div class="stat-row">
  ${stat(escapeHtml(savingsWord(ledger.tokens_saved_mean)), "Tokens saved per run")}
  ${stat(escapeHtml(savingsWord(ledger.time_saved_ms_mean)), "Time saved per run")}
  ${stat(String(ledger.runs), "Compiled runs")}
  ${stat(`${ledger.fail}/${ledger.runs}`, "Failed runs / total", ledger.runs === 0)}
</div>
<div class="stat-row">
  ${stat(String(drafts.c), "Drafts waiting to be approved", drafts.c === 0)}
  ${stat(String(on.c), "Live tools", on.c === 0)}
</div>`
      + (usage.runs > 0
        ? `<div class="panel"><h2>This month</h2><p class="muted">${month.runs} runs · ${(month.server_ms / 1000).toFixed(1)}s server compute · ${(month.raw_bytes / 1e6).toFixed(2)}MB raw compressed to ${(month.densified_bytes / 1000).toFixed(0)}KB sent to the model</p></div>`
        : "")
      + activity
      + `<div class="panel safe" style="margin-top:28px"><h2>How to read these numbers</h2>
<ul>
<li><strong>"measured"</strong> comes from shadow-run receipts — Eden executed the compiled version alongside the real one and compared.</li>
<li><strong>"estimated"</strong> is labelled as such: projected from recorded traces, not proven by a paired run.</li>
<li><strong>"not measured"</strong> means no evidence yet. It never silently reads as zero, and no number is shown without one of these labels.</li>
<li>A failure here means the compiled run errored — your agent received a structured result it could recover from, never a broken call.</li>
</ul></div>
<p style="margin-top:20px"><a href="/onboarding" class="btn secondary">Setup guide →</a> &nbsp; <a href="/workshop" class="btn">Approve tools${drafts.c ? ` (${drafts.c} waiting)` : ""} →</a></p>`;
    return html("Eden — Dashboard", body);
  }

  if (url.pathname === "/workshop") {
    const denied = pageAuth(req, wsId);
    if (denied) return denied;
    if (!wsId) return new Response("unauthorized", { status: 401 }); // unreachable; narrows for TS
    const tools = await d.all<{ id: string; name: string; state: string; uses_count: number }>(
      `SELECT id, name, state, uses_count FROM tool WHERE workspace_id = ? ORDER BY CASE state WHEN 'draft' THEN 0 WHEN 'on' THEN 1 ELSE 2 END, name`,
      [wsId],
    );
    const rows = tools
      .map((t) => `<div class="step"><div class="step-head"><span class="step-title"><a href="/workshop/${t.id}"><code>${escapeHtml(t.name)}</code></a></span><span class="badge ${t.state === "on" ? "ok" : "todo"}">${escapeHtml(t.state)}</span><span class="muted" style="margin-left:12px">${t.uses_count} uses</span></div></div>`)
      .join("");
    return html("Eden — Approve", nav("Approve") + `<h1>Approve compiled tools</h1>
<p class="sub">This is the only place a tool goes live. Nothing runs in front of your agent until you approve it here — an API key can never flip a tool On.</p>
${rows || `<p class="muted">No drafts yet. Run your agent, or <a href="/import">import traces</a> — repeatable workflows will appear here.</p>`}`);
  }

  const ws = url.pathname.match(/^\/workshop\/([^/]+)$/);
  if (ws && req.method === "GET") {
    const denied = pageAuth(req, wsId);
    if (denied) return denied;
    if (!wsId) return new Response("unauthorized", { status: 401 }); // unreachable; narrows for TS
    const t = await d.get<{ id: string; name: string; when_to_use: string; state: string; steps: string; published?: number }>(
      `SELECT id, name, when_to_use, state, steps, published FROM tool WHERE id = ? AND workspace_id = ?`,
      [ws[1], wsId],
    );
    if (!t) {
      return html(
        "Eden — Not found",
        nav("Approve") +
          `<h1>Tool not found</h1><p class="sub">This tool does not exist in your workspace (it may have been removed, or the link is from another workspace).</p>
           <p><a href="/workshop" class="btn secondary">Back to Approve →</a></p>`,
      );
    }
    const steps = jsonRows(t.steps) as Array<{ id: string; name: string; kind: string; url?: string }>;
    const list = steps.length
      ? `<h2 style="margin-top:20px">What it runs</h2><table class="activity">${steps
          .map((s, i) => `<tr><td>${i + 1}. ${escapeHtml(String(s.name))}</td><td>${escapeHtml(String(s.kind))}</td><td>${s.url ? escapeHtml(String(s.url)) : ""}</td></tr>`)
          .join("")}</table>`
      : "";
    const approve =
      t.state !== "on"
        ? `<div class="panel" style="margin-top:20px"><h2>Go live?</h2>
           <p class="muted" style="margin-bottom:12px">Once approved, your agent's matching calls are served by this compiled tool — measured receipts land on the dashboard.</p>
           <form method="post" action="/v1/tools/${t.id}/approve"><button class="btn">Approve tool</button></form></div>`
        : t.published
          ? `<div class="panel good" style="margin-top:20px"><p class="success">✓ Live</p><p class="muted">Published on MCP as <code>${escapeHtml(t.name)}</code>.</p></div>`
          : `<div class="panel" style="margin-top:20px"><p>On for this workspace.</p>
             <form method="post" action="/v1/tools/${t.id}/approve" style="margin-top:10px"><button class="btn secondary">Publish to MCP</button></form></div>`;
    return html(
      `Eden — ${t.name}`,
      nav("Approve") +
        `<h1><code>${escapeHtml(t.name)}</code></h1>
         <p class="sub">${escapeHtml(t.when_to_use) || "No description recorded."}</p>
         <span class="badge ${t.state === "on" ? "ok" : "todo"}">${escapeHtml(t.state)}</span>
         ${list}${approve}`,
    );
  }

  // ── Self-serve signup: the door for actual users. ─────────────────────────
  // A visitor can read every page, but until they hold an API key they cannot
  // DO anything. This endpoint mints a workspace + key in one call, rate
  // limited per IP so abuse costs bounded resources. The key is returned ONCE;
  // only its sha256 is stored.
  if (url.pathname === "/v1/signup" && req.method === "POST") {
    const ip =
      req.headers.get("x-real-ip") ||
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "unknown";
    const RATE_LIMIT = 5;
    const WINDOW_MS = 3_600_000;
    await d.run(
      `CREATE TABLE IF NOT EXISTS signup_rate (ip TEXT PRIMARY KEY, hits INTEGER, window_start BIGINT)`,
      [],
    );
    const row = await d.get<{ hits: number; window_start: number }>(
      `SELECT hits, window_start FROM signup_rate WHERE ip = ?`,
      [ip],
    );
    const now = Date.now();
    const hits = row && now - row.window_start < WINDOW_MS ? row.hits : 0;
    if (hits >= RATE_LIMIT) {
      return Response.json(
        {
          error:
            "Too many workspaces created from this address this hour. Try again later, or run `eden wrap` locally — local use needs no key at all.",
        },
        { status: 429 },
      );
    }
    if (row) {
      await d.run(`UPDATE signup_rate SET hits = ? WHERE ip = ?`, [hits + 1, ip]);
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
    await d.run(`INSERT INTO workspace (id, name) VALUES (?, ?)`, [
      wsId,
      name || `workspace-${wsId.slice(3, 9)}`,
    ]);
    await d.run(`INSERT INTO api_key (prefix, hash, workspace_id) VALUES (?, ?, ?)`, [
      token.slice(0, 12),
      hashApiKey(token),
      wsId,
    ]);
    return Response.json({
      api_key: token,
      workspace_id: wsId,
      base_url: origin,
      note: "This key is shown once. Store it now.",
    });
  }

  // Signup page.
  if (url.pathname === "/signup" && req.method === "GET") {
    const body = nav("") + `
<h1>Get your API key</h1>
<p class="sub">One workspace, one key, thirty seconds. No credit card, no email confirmation — the key below is your account.</p>
<div class="panel" id="signupPanel">
  <label for="wsName" style="display:block;margin-bottom:6px;font-weight:600">Workspace name <span class="muted">(optional)</span></label>
  <input type="text" id="wsName" placeholder="my-agent-project" style="margin-bottom:14px;max-width:360px"/>
  <button class="btn" id="signupBtn">Create my workspace</button>
  <p id="signupErr" class="error-text" style="margin-top:10px"></p>
</div>
<div class="panel good hidden" id="donePanel">
  <h2>✓ Your workspace is ready</h2>
  <p class="muted" style="margin-bottom:10px">This key is shown <strong>once</strong>. Copy it somewhere safe now.</p>
  <pre><code id="keyOut"></code><button class="copy" onclick="copyText(this.previousElementSibling)">Copy</button></pre>
  <h2 style="margin-top:20px">Connect your agent</h2>
  <p style="margin-bottom:6px">Install the CLI and log in:</p>
  <pre><code>npm i -g eden
eden login --url ${escapeHtml(origin)} --key &lt;your key&gt;
eden wrap</code><button class="copy" onclick="copyText(this.previousElementSibling)">Copy</button></pre>
  <p class="muted">Then point your agent's <code>OPENAI_BASE_URL</code> at the local proxy (<code>http://127.0.0.1:8788/v1</code>) and run it as usual. Full guide in <a href="/onboarding" style="text-decoration:underline">Setup</a>.</p>
  <a href="/onboarding" class="btn secondary" style="margin-top:14px;display:inline-block">Open the setup guide →</a>
</div>
<script>
document.getElementById("signupBtn").addEventListener("click", async () => {
  const btn = document.getElementById("signupBtn");
  btn.disabled = true; btn.textContent = "Creating…";
  document.getElementById("signupErr").textContent = "";
  try {
    const res = await fetch("/v1/signup", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({ name: document.getElementById("wsName").value }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "Signup failed");
    document.getElementById("signupPanel").classList.add("hidden");
    document.getElementById("donePanel").classList.remove("hidden");
    document.getElementById("keyOut").textContent = j.api_key;
  } catch (err) {
    document.getElementById("signupErr").textContent = String(err.message || err);
    btn.disabled = false; btn.textContent = "Create my workspace";
  }
});
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
    const list: Array<Record<string, unknown>> = Array.isArray(body.traces) ? body.traces : [body as Record<string, unknown>];
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
    }
    // Redact credential-shaped values at the boundary. Clients vary — hooks
    // redact locally, SDKs may not — so the plane itself is the guarantee
    // that secrets never persist.
    const cleanEvents = (body.events as ToolEvent[]).map((e) => ({
      ...e,
      ...(e.args !== undefined ? { args: redact(e.args) as Record<string, unknown> } : {}),
      ...(e.result !== undefined ? { result: redact(e.result) } : {}),
      ...(typeof (e as { command?: string }).command === "string"
        ? { command: redact((e as { command: string }).command) }
        : {}),
    })) as ToolEvent[];
    const result = await ingest(
      d,
      wsId,
      body.run_id,
      cleanEvents,
      Boolean(body.stretch_end),
    );
    return Response.json(result, { status: 202 });
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

