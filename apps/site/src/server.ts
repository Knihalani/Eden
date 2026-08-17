import { openDb, workspaceForKey, type EdenDb } from "./db";
import { ingest } from "./cluster";
import { handleMcp } from "./mcp";
import { playTool } from "./playback";
import { handleForge } from "./forge";
import { escapeHtml, layout } from "./html";
import { findOnTool, wrapPlay, toolHasPlayback } from "./wrap";
import type { ToolEvent } from "@eden/core";

const PORT = Number(process.env.PORT || 8787);
let dbPromise: Promise<EdenDb> | null = null;

function db(): Promise<EdenDb> {
  if (!dbPromise) dbPromise = openDb(process.env.EDEN_DB || undefined).then(async (d) => {
    await seedBundle(d);
    return d;
  });
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

export async function handleFetch(req: Request): Promise<Response> {
  if (process.env.VERCEL && process.env.EDEN_DEV !== "1") {
    delete process.env.EDEN_AUTO_APPROVE;
  }
  const d = await db();
  const url = new URL(req.url);
  const origin = process.env.EDEN_PUBLIC_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${url.port || PORT}`);

  const forge = handleForge(url);
  if (forge) return forge;

  if (url.pathname === "/health") return Response.json({ ok: true });

  const wsId = await workspaceForKey(d, req.headers.get("authorization"));

  if (url.pathname === "/dashboard" || url.pathname === "/") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const usage = (await d.get<{
      runs: number;
      server_ms: number;
      steps: number;
      raw_bytes: number;
      densified_bytes: number;
    }>(
      `SELECT COUNT(*) as runs, COALESCE(SUM(r.server_ms),0) as server_ms, COALESCE(SUM(r.steps_attempted),0) as steps,
              COALESCE(SUM(r.raw_bytes),0) as raw_bytes, COALESCE(SUM(r.densified_bytes),0) as densified_bytes
       FROM tool_run r JOIN tool t ON t.id = r.tool_id WHERE t.workspace_id = ?`,
      [wsId],
    )) || { runs: 0, server_ms: 0, steps: 0, raw_bytes: 0, densified_bytes: 0 };
    const drafts = (await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM tool WHERE workspace_id = ? AND state = 'draft'`, [wsId])) || { c: 0 };
    const on = (await d.get<{ c: number }>(`SELECT COUNT(*) as c FROM tool WHERE workspace_id = ? AND state = 'on'`, [wsId])) || { c: 0 };
    const lines = [
      `<p class="muted">Eden is watching the agent work. Same stretch twice → a draft in Workshop. Approve only here — a key never turns a tool On.</p>`,
      `<div class="row">Drafts waiting <strong>${drafts.c}</strong></div>`,
      `<div class="row">Tools on <strong>${on.c}</strong></div>`,
    ];
    if (usage.runs > 0) {
      lines.push(
        `<div class="row">This month: ${(usage.server_ms / 1000).toFixed(1)}s server compute · ${usage.steps} steps · ${(usage.raw_bytes / 1e6).toFixed(2)}MB raw → ${(usage.densified_bytes / 1000).toFixed(0)}KB to the model · ${usage.runs} runs</div>`,
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
    const steps = JSON.parse(t.steps) as Array<{ id: string; name: string; kind: string; url?: string }>;
    const list = steps.map((s) => `<div class="row"><code>${escapeHtml(s.name)}</code> · ${escapeHtml(s.kind)}${s.url ? ` · ${escapeHtml(s.url)}` : ""}</div>`).join("");
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
    if (process.env.VERCEL && process.env.EDEN_DEV !== "1") return new Response("unauthorized", { status: 401 });
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
        seen: JSON.parse(t.seen || "[]"),
        has_playback: JSON.parse(t.steps || "[]").some((s: { url?: string }) => Boolean(s.url)),
      })),
    });
  }

  if (url.pathname === "/v1/ingest" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { run_id: string; events: ToolEvent[]; stretch_end?: boolean };
    const result = await ingest(d, wsId, body.run_id, body.events || [], Boolean(body.stretch_end));
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
        seen: JSON.parse(t.seen || "[]") as string[],
        required_k: Number(t.required_k) || 2,
        urls: (JSON.parse(t.steps || "[]") as Array<{ url?: string }>).map((s) => s.url).filter(Boolean) as string[],
      })),
      knock: knock ? { message: `draft ${knock.tool_id}`, tool_id: knock.tool_id } : null,
    });
  }

  if (url.pathname === "/v1/knock/reject" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const k = await d.get<{ id: string; tool_id: string }>(
      `SELECT id, tool_id FROM knock WHERE workspace_id = ? AND resolution IS NULL LIMIT 1`,
      [wsId],
    );
    if (k) {
      const tool = await d.get<{ fingerprint: string }>(`SELECT fingerprint FROM tool WHERE id = ?`, [k.tool_id]);
      await d.run(`UPDATE knock SET resolution = 'reject' WHERE id = ?`, [k.id]);
      if (tool) await d.run(`INSERT OR IGNORE INTO ignore_fp (workspace_id, fingerprint) VALUES (?, ?)`, [wsId, tool.fingerprint]);
      await d.run(`DELETE FROM tool WHERE id = ?`, [k.tool_id]);
    }
    return Response.json({ ok: true });
  }

  const approve = url.pathname.match(/^\/v1\/tools\/([^/]+)\/approve$/);
  if (approve && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    await d.run(`UPDATE tool SET state = 'on', published = 1 WHERE id = ? AND workspace_id = ?`, [approve[1], wsId]);
    if (req.headers.get("accept")?.includes("json")) return Response.json({ ok: true });
    return Response.redirect(`${origin}/workshop/${approve[1]}`, 303);
  }

  if (url.pathname === "/v1/play" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { name: string; issue?: string; issues?: string; ids?: string };
    const tool = await d.get<{ id: string; name: string; steps: string }>(
      `SELECT id, name, steps FROM tool WHERE name = ? AND state = 'on' AND workspace_id = ?`,
      [body.name, wsId],
    );
    if (!tool) return new Response("not found", { status: 404 });
    const receipt = await playTool(d, tool, {
      issue: body.issue || "",
      issues: body.issues || body.ids || body.issue || "",
      ids: body.ids || body.issues || body.issue || "",
      origin,
    });
    return Response.json(receipt);
  }

  if (url.pathname === "/v1/wrap" && req.method === "POST") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as { name: string; args?: Record<string, string>; run_id?: string };
    const tool = await findOnTool(d, wsId, body.name);
    if (!tool || !toolHasPlayback(tool)) return Response.json({ action: "original" });
    return Response.json(await wrapPlay(d, tool, body.args || {}, origin, body.run_id));
  }

  if (url.pathname === "/mcp") {
    if (!wsId) return new Response("unauthorized", { status: 401 });
    if (req.method === "GET") return new Response("ok", { headers: { "content-type": "text/event-stream" } });
    const parsed = await readJson(req);
    if (!parsed.ok) return parsed.res;
    const rpc = parsed.value as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    const out = await handleMcp(d, wsId, rpc, origin);
    if (out === null) return new Response(null, { status: 202 });
    return Response.json(out);
  }

  return new Response("not found", { status: 404 });
}

