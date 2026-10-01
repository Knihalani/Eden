import type { Candidate, LiveTool, Store } from "./store";
import { rolloutPartition, toolsListTitle } from "@eden/ir";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function seq(names: string[]): string {
  return names.map((n) => `<span class="pill">${esc(n)}</span>`).join(`<span class="arr">→</span>`);
}

function fmtAbs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toString();
}

function connected(store: Store): boolean {
  return Date.now() - store.lastHeartbeat() < 30_000;
}

function verdictBadge(verdict: string): string {
  const v = verdict.toLowerCase();
  const cls = v === "pass" ? "pass" : v === "fail" ? "fail" : "";
  return `<span class="badge ${cls}">${esc(verdict)}</span>`;
}

function servingOf(tools: LiveTool[]) {
  return rolloutPartition(tools.filter((t) => t.state === "live").map((t) => ({ rollout: t.rollout })));
}

export function layout(
  title: string,
  body: string,
  path: string,
  token = "eden_dev",
  sig = "",
  serving?: { canary: number; live: number },
): string {
  const toolsNav = esc(toolsListTitle(serving ?? { canary: 0, live: 0 }));
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} · Eden</title>
<style>
  :root { color-scheme: dark; --bg:#0c0d0a; --fg:#eceadd; --muted:#8b8878; --line:#24251e; --accent:#c8f542; --bad:#ff6b4a; --card:#14150f; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; gap:1.5rem; align-items:center; padding:1rem 1.5rem; border-bottom:1px solid var(--line); }
  header strong { letter-spacing:.08em; font-size:12px; text-transform:uppercase; color:var(--accent); }
  a { color:var(--fg); text-decoration:none; }
  a[aria-current="page"] { color:var(--accent); }
  main { padding:1.5rem; max-width:68rem; }
  h1 { font-size:1.35rem; font-weight:560; margin:0 0 .35rem; letter-spacing:-.02em; }
  .lede { color:var(--muted); max-width:42rem; margin:0 0 1.5rem; }
  .strip { display:flex; gap:1rem; flex-wrap:wrap; padding:.85rem 1rem; border:1px solid var(--line); background:var(--card); margin-bottom:1.25rem; font-family:ui-monospace,monospace; font-size:12px; }
  .strip span { color:var(--muted); }
  .dot { width:.55rem; height:.55rem; border-radius:99px; background:var(--muted); display:inline-block; }
  .dot.on { background:var(--accent); box-shadow:0 0 8px var(--accent); }
  .grid { display:grid; gap:1rem; }
  .card { border:1px solid var(--line); background:var(--card); padding:1rem 1.1rem; }
  .card h2 { font-size:1rem; margin:0 0 .6rem; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
  .pills { display:flex; flex-wrap:wrap; align-items:center; gap:.35rem; margin:.4rem 0 .8rem; }
  .pill { font:12px ui-monospace,monospace; border:1px solid var(--line); padding:.15rem .4rem; }
  .arr { color:var(--muted); font-size:12px; }
  .nums { display:flex; gap:1.25rem; font-variant-numeric:tabular-nums; margin:.5rem 0 1rem; }
  .nums b { display:block; font-size:1.35rem; letter-spacing:-.03em; }
  .nums span { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
  .row { display:flex; gap:.5rem; flex-wrap:wrap; }
  button, .btn { background:var(--accent); color:#111; border:0; padding:.45rem .8rem; font:600 13px ui-sans-serif,system-ui; cursor:pointer; }
  button:focus-visible, a:focus-visible, .btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .ghost { background:transparent; color:var(--fg); border:1px solid var(--line); }
  .bad { color:var(--bad); }
  .muted { color:var(--muted); }
  .badge { font:11px/1.2 ui-monospace,monospace; border:1px solid var(--line); padding:.12rem .4rem; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .badge.pass { color:var(--accent); border-color:var(--accent); }
  .badge.fail { color:var(--bad); border-color:var(--bad); }
  code { font-family:ui-monospace,monospace; font-size:.9em; }
  .graph { display:flex; flex-direction:column; gap:.4rem; margin:1rem 0; }
  .step { font:13px/1.4 ui-monospace,monospace; padding:.45rem .6rem; border-left:2px solid var(--accent); background:#10110c; }
  .step.island { border-color:#f5d742; }
  .step.assert { border-color:#7ec8ff; }
  .empty { color:var(--muted); padding:2rem 0; }
  kbd { font:11px ui-monospace,monospace; border:1px solid var(--line); padding:.05rem .3rem; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .dot.on { box-shadow: none; }
  }
</style>
<header>
  <strong>Eden</strong>
  <a href="/" ${path === "/" ? 'aria-current="page"' : ""}>Inbox</a>
  <a href="/live" ${path === "/live" ? 'aria-current="page"' : ""}>${toolsNav}</a>
</header>
<main>${body}</main>
<script>
window.EDEN_TOKEN = ${JSON.stringify(token)};
async function post(url) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + window.EDEN_TOKEN }, body: "{}" });
  const j = await r.json();
  if (!r.ok) { alert(j.error || r.status); return; }
  location.reload();
}
async function del(url) {
  const r = await fetch(url, { method: "DELETE", headers: { authorization: "Bearer " + window.EDEN_TOKEN } });
  const j = await r.json();
  if (!r.ok) { alert(j.error || r.status); return; }
  location.reload();
}
(function () {
  const path = ${JSON.stringify(path)};
  if (path !== "/" && path !== "/inbox") return;
  let sig = ${JSON.stringify(sig)};
  async function pollInbox() {
    try {
      const r = await fetch("/v1/inbox");
      const j = await r.json();
      if (j.sig && sig && j.sig !== sig) location.reload();
      if (j.sig) sig = j.sig;
    } catch {}
  }
  setInterval(pollInbox, 2500);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "c" && e.key !== "C") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    post("/v1/compile");
  });
})();
</script>
</html>`;
}

export function inboxPage(store: Store, token?: string): string {
  const on = connected(store);
  const cands = store.candidates();
  const live = store.tools().filter((t) => t.state === "live");
  const save = store.savings();
  const cards = cands.length
    ? cands.map(candidateCard).join("")
    : `<p class="empty">No stretches yet. Point your agent at this wrap — we compile the repeating parts and show you what we refused.</p>`;
  const moment = cands.some((c) => c.program && !c.refusal)
    ? `<p class="lede">We turned a repeating stretch into one tool that cannot skip steps. It ships when shadow shows at least 2× fewer LLM calls — latency is reported, not a gate. INCONCLUSIVE does not ship.</p>`
    : "";
  const body = `
    <h1>Inbox</h1>
    <p class="lede">Point Eden at the agent you already have. Repeating stretches become one tool that cannot skip checks. We ship when quality holds and tokens or time are measured.</p>
    ${moment}
    <div class="strip">
      <span><i class="dot ${on ? "on" : ""}"></i> wrap ${on ? "connected" : "waiting"}</span>
      <span>OPENAI_BASE_URL=http://127.0.0.1:8788/v1</span>
      <span>live ${live.length}</span>
      <span>${save.tokensSavedMean ? Math.round(save.tokensSavedMean) + " tokens saved" : "not measured"}</span>
      <span><kbd>c</kbd> compile</span>
    </div>
    <div class="row" style="margin-bottom:1rem">
      <button onclick="post('/v1/compile')">Compile traces</button>
    </div>
    <div class="grid">${cards}</div>`;
  return layout("Inbox", body, "/", token, store.inboxSig(), servingOf(store.tools()));
}

function candidateCard(c: Candidate): string {
  if (c.refusal && !c.program) {
    return `<article class="card">
      <h2>Refused ${verdictBadge("FAIL")}</h2>
      <div class="pills">${seq(c.sequence)}</div>
      <p class="bad">${esc(c.refusal.reason)}</p>
      <div class="row"><button class="ghost" onclick="del('/v1/candidates/${esc(c.id)}')">Dismiss</button></div>
    </article>`;
  }
  const m = c.manifest;
  const witnesses = c.program?.contract.witnesses;
  const why =
    c.verdict === "pending"
      ? c.refusal?.reason || "Shadow pending. Start eden wrap so we can replay the stretch."
      : c.verdict === "INCONCLUSIVE"
        ? "INCONCLUSIVE — not enough in-distribution witnesses."
        : c.verdict === "FAIL"
          ? c.refusal?.reason || "Shadow failed."
          : "";
  const nums = m
    ? `<div class="nums">
        <div><b>${m.tokensMeasured && m.tokensSaved != null ? fmtAbs(m.tokensSaved) : "—"}</b><span>tokens saved</span></div>
        <div><b>${m.timeMeasured && m.timeSavedMs != null ? fmtAbs(m.timeSavedMs) : "—"}</b><span>ms saved</span></div>
        <div><b>${((m.skipRateAfter ?? 0) * 100).toFixed(0)}%</b><span>skips after</span></div>
        <div><b>${witnesses ?? "—"}</b><span>witnesses</span></div>
      </div>`
    : `<p class="muted">${esc(why)}${witnesses != null ? ` ${witnesses} witnesses.` : ""}</p>`;
  return `<article class="card">
    <h2>${esc(c.program?.name || "stretch")} ${verdictBadge(c.verdict)}</h2>
    <div class="pills">${seq(c.sequence)}</div>
    ${nums}
    ${m && why && c.verdict !== "PASS" ? `<p class="muted">${esc(why)}</p>` : ""}
    <div class="row">
      <button ${c.verdict === "PASS" ? `onclick="post('/v1/tools/${esc(c.id)}/approve')"` : "disabled"}>Approve</button>
      ${c.program && c.verdict !== "PASS" && !c.refusal?.reason?.startsWith("uncovered") && c.refusal?.reason !== "no wrap registry — start eden wrap to replay this stretch" ? `<button class="ghost" onclick="post('/v1/candidates/${esc(c.id)}/shadow')">Shadow</button>` : ""}
      <a class="btn ghost" href="/tools/${esc(c.id)}">Open</a>
    </div>
  </article>`;
}

export function toolPage(store: Store, id: string, token?: string): string {
  const c = store.candidate(id);
  const live = store.tool(id);
  const program = live?.program || c?.program;
  if (!program && !c?.refusal)
    return layout("Tool", `<p class="empty">Unknown tool.</p>`, "/live", token, "", servingOf(store.tools()));
  const steps = (program?.steps ?? [])
    .map((s) => {
      if (s.kind === "tool") return `<div class="step">${esc(s.id)} · ${esc(s.tool)}</div>`;
      if (s.kind === "island") return `<div class="step island">${esc(s.id)} · island</div>`;
      if (s.kind === "assert") return `<div class="step assert">${esc(s.id)} · assert ${esc(s.expr)}</div>`;
      return `<div class="step">${esc(s.id)} · loop</div>`;
    })
    .join("");
  const m = program?.manifest || c?.manifest;
  const body = `
    <h1>${esc(program?.name || "Refused stretch")}</h1>
    <p class="lede">${esc(program?.description || c?.refusal?.reason || "")}</p>
    ${
      m
        ? `<div class="nums">
      <div><b>${m.tokensMeasured && m.tokensSaved != null ? fmtAbs(m.tokensSaved) : "—"}</b><span>tokens saved</span></div>
      <div><b>${m.timeMeasured && m.timeSavedMs != null ? fmtAbs(m.timeSavedMs) : "—"}</b><span>ms saved</span></div>
      <div><b>${((m.skipRateAfter ?? 0) * 100).toFixed(0)}%</b><span>skips after</span></div>
    </div>`
        : ""
    }
    <div class="graph">${steps || `<p class="bad">${esc(c?.refusal?.reason || "")}</p>`}</div>
    <div class="row">
      ${c && c.verdict === "PASS" ? `<button onclick="post('/v1/tools/${esc(id)}/approve')">Approve</button>` : ""}
      ${live?.state === "live" ? `<button class="ghost" onclick="post('/v1/tools/${esc(id)}/pause')">Pause</button>` : ""}
      ${live && live.state !== "live" ? `<button class="ghost" onclick="post('/v1/tools/${esc(id)}/resume')">Resume</button>` : ""}
      ${live ? `<button class="ghost" onclick="post('/v1/tools/${esc(id)}/rollback')">Rollback</button>` : ""}
    </div>`;
  return layout(program?.name || "Tool", body, "/live", token, "", servingOf(store.tools()));
}

export function livePage(store: Store, token?: string): string {
  const tools: LiveTool[] = store.tools();
  const save = store.savings();
  const cards = tools.length
    ? tools
        .map((t) => {
          const stats = store.receiptStats(t.id);
          return `<article class="card">
      <h2>${esc(t.name)} ${verdictBadge(t.state)}</h2>
      <p class="muted">${esc(t.version.slice(0, 12))} · ${stats.n} runs · ${stats.fail} failed · ${stats.llm} island calls</p>
      <div class="row">
        <a class="btn ghost" href="/tools/${esc(t.id)}">Open</a>
        ${t.state === "live" ? `<button class="ghost" onclick="post('/v1/tools/${esc(t.id)}/pause')">Pause</button>` : `<button class="ghost" onclick="post('/v1/tools/${esc(t.id)}/resume')">Resume</button>`}
        <button class="ghost" onclick="post('/v1/tools/${esc(t.id)}/rollback')">Rollback</button>
      </div>
    </article>`;
        })
        .join("")
    : `<p class="empty">0 programs. Approve one from the inbox.</p>`;
  const saved = save.tokensSavedMean
    ? Math.round(save.tokensSavedMean) + " tokens saved"
    : save.timeSavedMsMean
      ? Math.round(save.timeSavedMsMean) + " ms saved"
      : "not measured";
  const strip = `<div class="strip">
    <span>live ${save.live}</span>
    <span>${save.runs} runs</span>
    <span>${save.fail} failed</span>
    <span>${saved}</span>
  </div>`;
  const serving = servingOf(tools);
  const title = toolsListTitle(serving);
  return layout(title, `<h1>${esc(title)}</h1>${strip}<div class="grid">${cards}</div>`, "/live", token, "", serving);
}
