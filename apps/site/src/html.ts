const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0b;color:#e5e5e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.6;min-height:100vh}
a{color:#e5e5e6;text-decoration:none}
.container{max-width:820px;margin:0 auto;padding:32px 24px 64px}
header.top{display:flex;align-items:center;gap:24px;border-bottom:1px solid #232326;padding-bottom:12px;margin-bottom:28px}
.brand{font-weight:700;font-size:16px;letter-spacing:.5px;color:#fff}
.brand span{color:#c23434}
.nav{display:flex;gap:18px;font-size:14px;margin-left:auto}
.nav a{padding:4px 0;border-bottom:2px solid transparent;color:#858589}
.nav a.active{border-bottom-color:#c23434;color:#fff}
.nav a:hover{color:#fff}
h1{font-size:22px;font-weight:600;margin-bottom:4px}
h2{font-size:15px;font-weight:600;margin-bottom:10px}
.sub{color:#858589;font-size:14px;margin-bottom:28px}
.step{border:1px solid #232326;border-radius:8px;padding:20px;margin-bottom:12px;background:#111113}
.step.done{border-color:#1d3b25}
.step.current{border-color:#8b1a1a}
.num{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;font-size:12px;font-weight:600;margin-right:10px;flex-shrink:0}
.done .num{background:#1d3b25;color:#4ade80}
.current .num{background:#8b1a1a;color:#fff}
.pending .num{background:#232326;color:#858589}
.step-head{display:flex;align-items:center;margin-bottom:8px}
.step-title{font-weight:600;font-size:15px}
.badge{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.5px}
.badge.ok{background:#1d3b25;color:#4ade80}
.badge.todo{background:#232326;color:#858589}
.badge.action{background:#8b1a1a;color:#fff}
code{background:#1a1a1d;padding:2px 6px;border-radius:4px;font-size:13px;color:#c4c4c6}
pre{background:#0d0d0f;border:1px solid #232326;border-radius:6px;padding:12px 14px;font-size:13px;overflow-x:auto;margin:10px 0;position:relative}
pre code{background:none;padding:0;color:#b8b8bc}
.copy{position:absolute;top:6px;right:6px;background:#232326;border:none;color:#858589;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px}
.copy:hover{color:#e5e5e6}
.btn{display:inline-block;background:#8b1a1a;color:#fff;padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:14px;font-weight:500;text-decoration:none}
.btn:hover{background:#a02020}
.btn.secondary{background:#232326;color:#e5e5e6}
.btn.secondary:hover{background:#2c2c30}
textarea{width:100%;min-height:160px;background:#0d0d0f;border:1px solid #232326;border-radius:6px;color:#e5e5e6;font-family:monospace;font-size:13px;padding:10px;resize:vertical}
textarea:focus{outline:none;border-color:#8b1a1a}
select,input[type=text]{background:#0d0d0f;border:1px solid #232326;border-radius:6px;color:#e5e5e6;padding:8px 12px;font-size:14px;width:100%}
select:focus,input[type=text]:focus{outline:none;border-color:#8b1a1a}
.muted{color:#858589;font-size:13px}
.stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:14px 0}
.stat{background:#111113;border:1px solid #232326;border-radius:8px;padding:16px}
.stat-val{font-size:24px;font-weight:600;color:#fff}
.stat-val.dim{color:#858589;font-size:17px;line-height:36px}
.stat-label{font-size:12px;color:#858589;margin-top:2px}
.panel{border:1px solid #232326;border-radius:8px;background:#111113;padding:18px 20px;margin:14px 0}
.panel.good{border-left:3px solid #2f6b3f}
.panel.safe{border-left:3px solid #2563a8}
.panel.warn{border-left:3px solid #8a6d1d}
.panel ul{margin:6px 0 0 18px}
.panel li{margin-bottom:4px}
.activity{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
.activity td{padding:7px 8px;border-top:1px solid #1c1c1f;color:#c9c9cc}
.activity td:first-child{color:#fff;font-weight:500}
.activity td.num-cell{text-align:right;font-variant-numeric:tabular-nums;color:#858589}
.success{color:#4ade80}
.error-text{color:#ef4444}
footer.page{margin-top:40px;padding-top:14px;border-top:1px solid #1c1c1f;color:#5c5c60;font-size:12px}
`;

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body><div class="container">${body}${footer()}</div>
<script>
function copyText(el){navigator.clipboard.writeText(el.textContent.trim());var b=el.parentElement.querySelector('.copy');if(b){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1200);}}
</script>
</body>
</html>`;
}

function footer(): string {
  return `<footer class="page">Eden compiles repeated agent workflows into single-call tools.
  It runs beside your agent, never in front of it: if Eden is broken, slow, or wrong, your calls still go through.</footer>`;
}

/** Copy button bound to a sibling <code> block via copyText(). */
export function copyBtn(): string {
  return `<button class="copy" onclick="copyText(this.previousElementSibling)">Copy</button>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function nav(active: string): string {
  const items = [
    ["/onboarding", "Setup"],
    ["/dashboard", "Dashboard"],
    ["/workshop", "Approve"],
    ["/import", "Import"],
  ];
  const head = `<header class="top"><span class="brand">eden<span>.</span></span><nav class="nav">${items
    .map(([href, label]) => `<a href="${href}" class="${active === label ? "active" : ""}">${label}</a>`)
    .join("")}</nav></header>`;
  return head;
}
