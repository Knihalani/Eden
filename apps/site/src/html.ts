export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; --bg:#0e0f0c; --fg:#e8e6dc; --muted:#8a8778; --line:#2a2b24; --accent:#c8f542; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui; background: var(--bg); color: var(--fg); }
  header { display:flex; gap:1.5rem; align-items:baseline; padding:1rem 1.5rem; border-bottom:1px solid var(--line); }
  a { color: var(--fg); text-decoration: none; }
  a[aria-current="page"] { color: var(--accent); }
  main { padding: 1.5rem; max-width: 52rem; }
  h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 1rem; }
  .muted { color: var(--muted); }
  .row { padding: .75rem 0; border-bottom: 1px solid var(--line); }
  button { background: var(--accent); color: #111; border:0; padding:.4rem .8rem; font: inherit; cursor:pointer; }
  code { font-family: ui-monospace, monospace; font-size: .9em; }
</style>
<header>
  <strong>Eden</strong>
  <a href="/dashboard" ${title === "Dashboard" ? 'aria-current="page"' : ""}>Dashboard</a>
  <a href="/workshop" ${title === "Workshop" || title.startsWith("Tool") ? 'aria-current="page"' : ""}>Workshop</a>
</header>
<main>${body}</main>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
