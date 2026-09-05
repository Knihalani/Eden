import { STAGE_SCRIPT } from "./stage";

const BASE_CSS = `
:root{
  --bg:oklch(0.16 0.012 260);
  --fg:oklch(0.93 0.012 260);
  --muted:oklch(0.78 0.014 260);
  --line:oklch(0.32 0.012 260);
  --well:oklch(0.145 0.01 260);
  --focus:oklch(0.85 0.01 260);
  --tap:44px;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased;text-size-adjust:100%;color-scheme:dark}
body{
  background:var(--bg);
  color:var(--fg);
  font-family:"Bricolage Grotesque",ui-sans-serif,system-ui,sans-serif;
  font-size:16px;
  font-weight:500;
  line-height:1.55;
  min-height:100dvh;
  text-rendering:optimizeLegibility;
}
img{display:block;max-width:100%}
a{color:inherit;text-decoration:none}
a.inline{text-decoration:underline;text-underline-offset:3px}
.skip{position:absolute;left:-999px;top:10px;background:var(--fg);color:var(--bg);padding:8px 12px;z-index:40}
.skip:focus{left:12px}
.wrap{max-width:40rem;margin:0 auto;padding:0 1.35rem 5.5rem}
header.top{
  position:sticky;top:0;z-index:8;
  display:flex;align-items:center;gap:1rem;flex-wrap:wrap;
  background:var(--bg);
  padding:0.9rem 0 0.85rem;
  margin-bottom:2.75rem;
  border-bottom:1px solid var(--line);
}
.brand{
  display:inline-flex;align-items:center;gap:0.65rem;
  min-height:var(--tap);color:var(--fg);
  font-size:0.9375rem;font-weight:500;letter-spacing:-0.02em;
}
.brand-mark{width:2.5rem;height:auto;aspect-ratio:956/916;flex-shrink:0}
.brand-name{font-weight:500}
.nav{display:flex;align-items:center;gap:0.15rem;margin-left:auto;flex-wrap:wrap;font-size:0.875rem}
.nav a,.nav button.link{
  min-height:44px;display:inline-flex;align-items:center;
  padding:0 0.7rem;border:0;background:none;color:var(--muted);
  cursor:pointer;font:inherit;letter-spacing:0.01em;
}
.nav a.active{color:var(--fg)}
.nav a:hover,.nav button.link:hover{color:var(--fg)}
h1{font-size:1.65rem;font-weight:600;letter-spacing:-0.03em;line-height:1.2;text-wrap:balance;margin-bottom:0.45rem}
h1.display{
  font-family:"Source Serif 4",ui-serif,Georgia,serif;
  font-size:clamp(2.35rem,6.2vw,3.35rem);
  font-weight:400;letter-spacing:-0.035em;line-height:1.12;
  max-width:20ch;margin:0;
}
h2{font-size:0.8rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted);margin-bottom:0.55rem}
.sub,.lede{color:var(--muted);text-wrap:pretty}
.sub{font-size:1rem;margin-bottom:1.75rem;max-width:36ch;line-height:1.45}
.lede{font-size:1.125rem;margin:1.35rem 0 1.9rem;max-width:32ch;line-height:1.45}
.hero{min-height:calc(100svh - 7.5rem);display:flex;flex-direction:column;justify-content:center;padding-bottom:3rem}
.path{list-style:none;margin:0;padding:2.5rem 0 0;display:grid;gap:1.35rem;max-width:34ch;counter-reset:step}
.path li{padding-left:1.75rem;position:relative;color:var(--muted);font-size:0.98rem;line-height:1.45}
.path li::before{counter-increment:step;content:counter(step);position:absolute;left:0;top:0.05em;color:var(--fg);font-variant-numeric:tabular-nums;font-size:0.8rem}
.path strong{display:block;color:var(--fg);font-weight:600;margin-bottom:0.15rem}
pre{
  background:var(--well);border:1px solid var(--line);border-radius:8px;
  padding:1rem 4.2rem 1rem 1rem;font-size:0.8125rem;line-height:1.55;
  overflow-x:auto;margin:1rem 0;position:relative;
}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.84em}
pre code{background:none;padding:0;color:color-mix(in oklch,var(--fg) 82%, var(--muted));white-space:pre-wrap;word-break:break-word}
.copy{
  position:absolute;top:0.55rem;right:0.55rem;min-height:32px;min-width:44px;
  background:transparent;border:1px solid var(--line);color:var(--muted);
  padding:0.3rem 0.55rem;border-radius:6px;cursor:pointer;font:inherit;font-size:0.75rem;
}
.copy:hover{color:var(--fg);border-color:var(--fg)}
.btn{
  display:inline-flex;align-items:center;justify-content:center;
  min-height:44px;padding:0 1.1rem;border:1px solid var(--line);border-radius:2px;
  background:transparent;color:var(--fg);cursor:pointer;
  font:inherit;font-size:0.95rem;font-weight:600;letter-spacing:-0.02em;
}
.btn:hover{border-color:var(--fg);background:transparent}
.btn:active{transform:translateY(1px)}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.btn.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
.btn.secondary:hover{border-color:var(--fg);background:transparent}
.btn.ghost{background:transparent;color:var(--muted);border:0;min-height:44px;padding-inline:0.2rem}
.btn.ghost:hover{color:var(--fg);background:transparent}
.btn.ship{background:var(--fg);color:var(--bg);border:0}
.btn.ship:hover{background:var(--fg);color:var(--bg);opacity:.9}
textarea,input[type=text],input[type=password]{
  width:100%;background:transparent;border:0;border-bottom:1px solid var(--line);
  border-radius:0;color:var(--fg);font:inherit;padding:0.7rem 0;caret-color:var(--fg);
}
textarea{min-height:12rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85rem;resize:vertical;border:1px solid var(--line);border-radius:8px;padding:0.85rem 1rem;background:var(--well)}
input:focus,textarea:focus{outline:none}
input[type=text]:focus,input[type=password]:focus{border-bottom-color:var(--fg)}
textarea:focus{border-color:var(--fg)}
label{display:block;font-size:0.8rem;letter-spacing:0.04em;text-transform:uppercase;color:var(--muted);margin-bottom:0.35rem;font-weight:600}
.field{margin-bottom:1.5rem;max-width:24rem}
.muted{color:var(--muted);font-size:0.9rem}
.figures{display:grid;gap:1rem 2rem;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));margin:1.75rem 0 2rem;padding:1.15rem 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.figures div{min-width:0}
.figures dt{font-size:0.75rem;letter-spacing:0.04em;text-transform:uppercase;color:var(--muted);margin-bottom:0.2rem}
.figures dd{font-size:1.05rem;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
.figures dd.dim{color:var(--muted);font-weight:500}
.callout{margin:0 0 1.5rem;font-size:1rem}
.activity{width:100%;border-collapse:collapse;font-size:0.9rem;margin-top:0.4rem}
.activity td{padding:0.7rem 0;border-top:1px solid var(--line);color:var(--muted);word-break:break-word}
.activity td:first-child{color:var(--fg);font-weight:600;padding-right:1rem}
.activity td.num-cell{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.tool-list{list-style:none;margin:1.25rem 0 0;border-top:1px solid var(--line)}
.tool-list li{display:flex;align-items:baseline;gap:0.85rem;padding:0.95rem 0;border-bottom:1px solid var(--line)}
.tool-list a{font-weight:600}
.tool-list .state{margin-left:auto;font-size:0.75rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--muted)}
.success{color:var(--fg)}
.error-text{color:oklch(0.78 0.12 25);min-height:1.2em;font-size:0.9rem}
footer.page{max-width:40rem;margin:0 auto;padding:0 1.35rem 2.4rem;color:var(--muted);font-size:0.78rem;line-height:1.45}
.hidden{display:none !important}
.empty{padding:0.25rem 0}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:0.85rem 1.1rem;margin-top:1.6rem}
.page-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:0.35rem}
.page-head a{color:var(--muted);font-size:0.9rem}
.page-head a:hover{color:var(--fg)}
.status{margin-top:1.5rem;color:var(--muted);max-width:38ch}
details.more{margin-top:2rem;color:var(--muted);font-size:0.9rem}
details.more summary{cursor:pointer;color:var(--fg);font-weight:600;margin-bottom:0.5rem;list-style:none}
details.more summary::-webkit-details-marker{display:none}
.secret-note{margin-top:0.6rem;font-size:0.8rem;color:var(--muted)}
.check{display:flex;gap:0.6rem;align-items:center;margin-top:0.85rem;font-size:0.9rem;color:var(--muted);font-weight:500}
.check input{width:auto}
:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
@media (max-width:560px){
  .wrap,footer.page{padding-left:1.1rem;padding-right:1.1rem}
  header.top{margin-bottom:2rem}
  .nav{width:100%;margin-left:0}
  h1.display{font-size:2.15rem}
}
@media (prefers-reduced-motion:reduce){
  .btn:active{transform:none}
}
`;

const MARKET_CSS = `
@property --bind{syntax:"<number>";inherits:true;initial-value:0}
body.market{
  width:100%;max-width:100%;overflow-x:clip;
  --bg:oklch(0.9 0.012 260);
  --fg:oklch(0.22 0.03 260);
  --muted:oklch(0.46 0.02 260);
  --line:oklch(0.82 0.015 260);
  --focus:oklch(0.4 0.03 260);
  --bind:0;
  --cream:oklch(0.93 0.025 95);
  background:var(--bg);color:var(--fg);color-scheme:light;
}
body.market main,body.market .reel,body.market .hero,body.market .hero-stage{
  width:100%;max-width:100%;
}
body.market .reel{min-height:260svh;width:100%}
body.market .hero{
  position:sticky;top:0;z-index:1;
  height:100svh;min-height:100svh;width:100%;overflow:hidden;
  display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 1fr;
  justify-content:stretch;justify-items:stretch;align-content:stretch;
  padding-bottom:0;background:var(--bg);
}
body.market canvas.stage{position:absolute;inset:0;display:none;pointer-events:none}
body.market .hero-header{
  position:relative;z-index:10;display:flex;align-items:center;justify-content:space-between;
  padding:0.85rem clamp(1.1rem,4vw,3.2rem) 0;
}
body.market .signin{
  display:inline-flex;align-items:center;min-height:44px;padding:0 0.15rem;
  font-size:0.9375rem;color:var(--muted);white-space:nowrap;
}
body.market .signin:hover{color:var(--fg)}
body.market .hero-stage{
  position:relative;z-index:2;width:100%;min-width:0;min-height:0;
  display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);
  justify-content:stretch;justify-items:stretch;align-items:stretch;align-content:stretch;
  padding:0.15rem clamp(1rem,3vw,2.2rem) 0.85rem;
}
body.market .promise{
  position:relative;z-index:8;display:flex;align-items:flex-end;justify-content:space-between;
  gap:1rem;max-width:none;pointer-events:none;padding:0.15rem 0.2rem 0.55rem;
}
body.market .promise .btn.ship{pointer-events:auto;flex-shrink:0}
body.market .promise h1{
  margin:0;max-width:18em;
  font-family:"Source Serif 4",ui-serif,Georgia,serif;font-weight:400;
  font-size:clamp(2.05rem,3.2vw,2.8rem);line-height:1.1;
  letter-spacing:-0.032em;text-wrap:balance;color:oklch(0.2 0.03 260);
}
body.market .promise .btn.ship{
  min-width:8.5rem;min-height:44px;align-self:center;
  background:var(--cream);color:oklch(0.16 0.05 252);border:0;
}
body.market .promise .btn.ship:hover{opacity:.92;background:var(--cream)}
body.market .promise .btn.ship:active{transform:scale(0.96)}
body.market .stage-slot{
  position:relative;z-index:2;min-width:0;width:100%;min-height:0;
  display:grid;align-self:stretch;overflow:visible;
}
body.market .stage-hit{
  position:relative;display:block;
  width:100%;height:100%;min-height:44px;margin:0;padding:0;border:0;
  background:transparent;color:inherit;cursor:grab;user-select:none;
  touch-action:pan-y;font:inherit;perspective:56rem;
}
body.market .stage-hit:active{cursor:grabbing}
body.market .deck{
  position:absolute;inset:1.2rem 4.4rem 2.4rem 1.2rem;
  pointer-events:none;
  transform:rotateX(-12deg) rotateY(-8deg) rotateZ(2deg) scale(0.92);
}
body.market .till{
  position:absolute;inset:0;width:100%;height:100%;margin:0;border-radius:18px;overflow:hidden;z-index:4;font:inherit;
}
body.market .slab{
  position:absolute;inset:0;display:grid;grid-template-rows:minmax(0,1fr) auto;
  padding:1.25rem 1.35rem 1.2rem;border-radius:18px;
  background:var(--cream);border:1px solid oklch(0.82 0.03 95);
  box-shadow:0 1.4rem 2.8rem oklch(0.4 0.03 260 / 0.22);
}
body.market .work{
  display:block;min-height:0;border-radius:8px;
  opacity:calc(1 - var(--bind));
  background:repeating-linear-gradient(
    180deg,
    oklch(0.52 0.04 80 / 0.34) 0 0.4rem,
    transparent 0.4rem 1.2rem
  );
}
body.market .go{
  display:inline-flex;align-items:center;justify-content:center;justify-self:end;
  min-height:44px;min-width:7.2rem;padding:0 1.1rem;border-radius:8px;
  background:oklch(0.99 0.018 95);color:oklch(0.16 0.05 252);
  font-size:0.92rem;font-weight:700;letter-spacing:-0.02em;
  box-shadow:0 0.15rem 0 oklch(0.82 0.03 95);
}
body.market .hold{
  position:relative;z-index:5;min-height:100svh;display:grid;place-items:center;
  background:oklch(0.86 0.014 260);
}
body.market .hold .go{
  min-width:min(70vw,20rem);min-height:18svh;border-radius:16px;
  font-size:clamp(1.8rem,5.5vw,3.6rem);letter-spacing:-0.05em;
  background:var(--cream);box-shadow:0 1.2rem 2.4rem oklch(0.4 0.03 260 / 0.18);
}
body.market .sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}
@media (max-width:820px){
  body.market .hero{height:100svh;min-height:100svh;overflow:hidden}
  body.market .hero .brand-name{display:none}
  body.market .hero-header{padding:0.8rem 1rem 0}
  body.market .hero-stage{
    display:flex;flex-direction:column;align-items:stretch;gap:0.45rem;
    padding:0.35rem 1rem 1.15rem;
  }
  body.market .promise{pointer-events:auto;padding:0 0 0.4rem;align-items:flex-start;flex-wrap:wrap}
  body.market .promise h1{font-size:clamp(1.75rem,7vw,2.25rem);max-width:none;color:oklch(0.2 0.03 260)}
  body.market .stage-slot{width:100%;min-width:0;min-height:0;flex:0 0 auto;height:auto}
  body.market .stage-hit{height:auto}
  body.market .deck{position:relative;inset:auto;transform:none !important;display:block}
  body.market .till{position:relative;height:calc(100svh - 14.5rem);min-height:0;max-height:calc(100svh - 14.5rem);overflow:hidden}
  body.market .hold .go{width:calc(100% - 2rem);min-width:0;min-height:16svh;font-size:clamp(1.7rem,11vw,2.8rem)}
}
@media (prefers-reduced-motion:reduce){
  body.market canvas.stage{display:none}
  body.market .promise .btn.ship:active{transform:none}
  body.market .deck{transform:none !important}
}
`;
const COPY_SCRIPT = `async function copyText(el){var b=el.parentElement&&el.parentElement.querySelector('.copy');try{await navigator.clipboard.writeText((el.textContent||'').trim());if(b){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1200);}}catch(e){if(b){b.textContent='Copy failed';setTimeout(function(){b.textContent='Copy'},1600);}}}`;

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<meta name="description" content="Making your agent do less work."/>
<link rel="icon" type="image/png" href="/favicon.png"/>
<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
<link rel="preconnect" href="https://fonts.bunny.net"/>
<link rel="stylesheet" href="https://fonts.bunny.net/css?family=bricolage-grotesque:500,600,700|source-serif-4:400,600&amp;display=swap"/>
<style>${BASE_CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="wrap"><main id="main">${body}</main></div>
${footer()}
<script>
${COPY_SCRIPT}
</script>
</body>
</html>`;
}

export function landingLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<meta name="description" content="Making your agent do less work."/>
<link rel="icon" type="image/png" href="/favicon.png"/>
<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
<link rel="preconnect" href="https://fonts.bunny.net"/>
<link rel="stylesheet" href="https://fonts.bunny.net/css?family=bricolage-grotesque:500,600,700|source-serif-4:400,600&amp;display=swap"/>
<style>${BASE_CSS}${MARKET_CSS}</style>
</head>
<body class="market">
<a class="skip" href="#content">Skip to content</a>
${body}
<script>
${COPY_SCRIPT}
${STAGE_SCRIPT}
</script>
</body>
</html>`;
}

function footer(): string {
  return `<footer class="page">If Eden is wrong, the agent keeps the old path.</footer>`;
}

export function brandLink(href: string): string {
  return `<a class="brand" href="${href}" aria-label="Eden"><img class="brand-mark" src="/logo.webp" alt="" width="40" height="38" decoding="async"/><span class="brand-name">Eden</span></a>`;
}

/** Copy button bound to a sibling <code> block via copyText(). */
export function copyBtn(): string {
  return `<button type="button" class="copy" onclick="copyText(this.previousElementSibling)">Copy</button>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function nav(active: string, signedIn: boolean): string {
  const brandHref = signedIn ? "/dashboard" : "/";
  const items = signedIn
    ? [
        ["/dashboard", "Desk"],
        ["/workshop", "Approve"],
        ["/import", "Import"],
      ]
    : [
        ["/onboarding", "Sign in"],
        ["/signup", "Sign up"],
      ];
  const links = items
    .map(([href, label]) => {
      const cls = active === label ? "active" : "";
      return `<a href="${href}" class="${cls}">${label}</a>`;
    })
    .join("");
  const signOut = signedIn
    ? `<form method="post" action="/v1/logout" style="display:inline;margin:0"><button type="submit" class="link">Sign out</button></form>`
    : "";
  return `<header class="top">${brandLink(brandHref)}<nav class="nav">${links}${signOut}</nav></header>`;
}
