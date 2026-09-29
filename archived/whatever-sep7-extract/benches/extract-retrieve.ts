/**
 * Extract + retrieve holdout. Do not edit after lock.
 * metric: miss count (lower). junk: false stores / false cards (lower).
 * cost_ms: median mixed extract+query batch (lower).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type AgentMemory } from "../../src/index";
import { knowQuery } from "../../packages/know/src/query";
import { injectFromText } from "../../packages/know/src/inject";
import {
  techniquesFromProse,
  triplesFromPage,
  wikiCapital,
} from "../../packages/know/src/extract";

const misses: string[] = [];
let junk = 0;

function miss(id: string, ok: boolean) {
  if (!ok) misses.push(id);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "er-"));
}

function texts(mem: AgentMemory): string {
  return mem.memories().map((m) => m.text).join("\n");
}

function top(mem: AgentMemory, q: string, k = 3): string {
  return mem.notesFor(q, k).map((m) => m.text).join("\n");
}

function absorb(stated: string): AgentMemory {
  const mem = openMemory({ dir: tmp() });
  mem.observe([{ role: "user", content: stated }]);
  return mem;
}

const KENYA = "https://en.wikipedia.org/wiki/Kenya";
const KENYA_INFOBOX = `<table class="infobox ib-country vcard">
<tr><th scope="row" class="infobox-label">Capital<div class="ib-country-largest">and largest city</div></th>
<td class="infobox-data"><a rel="mw:WikiLink" href="/wiki/Nairobi" title="Nairobi">Nairobi</a></td></tr>
</table>`;

const RFC_HTML = `<html><head><title>RFC 9110: HTTP Semantics</title></head>
<body><h1>RFC 9110 HTTP Semantics</h1><p>RFC 9110 obsoletes RFC 7230.</p></body></html>`;

const BUN_HTML = `<html><head><title>Bun</title>
<meta property="og:title" content="Bun — a fast JavaScript runtime"></head>
<body><p>Bun is a fast all-in-one JavaScript runtime.</p></body></html>`;

const LD_HTML = `<html><head>
<script type="application/ld+json">{"@type":"SoftwareApplication","name":"jq","description":"command-line JSON processor"}</script>
</head><body>jq</body></html>`;

const DISTRACTORS = [
  "Kai owns the billing service.",
  "Sam is the DRI for the dashboard.",
  "Production deploys use flyctl, never Heroku.",
  "Never commit .env or credentials.json",
  "Always run bun test before you push.",
  "Pull requests need two reviewers before merge.",
  "The staging DSN is postgres://staging.internal:5432/app",
  "Last Friday Redis ran out of memory in prod.",
  "I prefer dark mode in the dashboard.",
  "Kai's timezone is Pacific",
  "The on-call rotation is PagerDuty service Eden-API.",
  "CI uses depot.dev builders, not GitHub-hosted runners.",
  "The prod image is distroless, not Alpine.",
  "Feature flag billing_v2 lives in LaunchDarkly.",
  "The cluster lives in us-west-2, namespace eden-prod.",
  "SOC2 evidence pack is due 2026-09-30.",
  "Standup is 9:15 Pacific in #eng-standup.",
  "Webhooks sign with AWS Secrets Manager prod/stripe/webhook.",
  "The API lives at https://api.internal:8443/v2",
  "We standardized on bun for all CLIs.",
  "Staging deploys still use GitHub Actions.",
  "Kai prefers tabs, not spaces.",
  "The hotfix branch is release/2026-09-hotfix.",
  "Sentry project is eden-prod-web.",
  "Rate limit on /v1/complete is 40 rps.",
];

{
  const mem = absorb("Kai's timezone is Pacific");
  miss("ex-tz", /Pacific/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("Remember that production deploys use flyctl, never Heroku.");
  miss("ex-remember", /flyctl/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("I prefer dark mode in the dashboard.");
  miss("ex-prefer", /dark mode/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("Never commit .env or credentials.json");
  miss("ex-never", /\.env/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb(
    "Quick recap from standup. Traffic looked fine. Also the staging DSN is postgres://staging.internal:5432/app. Then we talked about lunch.",
  );
  miss("ex-buried", /staging\.internal/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("Don't use Alpine for the prod image; stick with distroless.");
  miss("ex-distroless", /distroless/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("fwiw, we standardized on bun for all CLIs.");
  miss("ex-std-bun", /\bbun\b/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("Note that CI uses depot.dev builders, not GitHub-hosted runners.");
  miss("ex-depot", /depot\.dev/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("SOC2 evidence pack is due 2026-09-30.");
  miss("ex-due", /2026-09-30/.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("The cluster lives in us-west-2, namespace eden-prod.");
  miss("ex-cluster", /us-west-2/i.test(texts(mem)) && /eden-prod/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("1. Always squash-merge to main.\n2. Never force-push shared branches.");
  miss("ex-list", /squash-merge/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb('The LaunchDarkly flag "billing_v2" is the new checkout.');
  miss("ex-flag", /billing_v2/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("Kai prefers tabs, not spaces.");
  miss("ex-tabs", /tabs/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("The on-call rotation is PagerDuty service Eden-API.");
  miss("ex-pd", /PagerDuty/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("Standup is 9:15 Pacific in #eng-standup.");
  miss("ex-standup", /eng-standup/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("Rate limit on /v1/complete is 40 rps.");
  miss("ex-rps", /40 rps/i.test(texts(mem)));
  mem.close();
}

{
  const mem = absorb("Last Friday Redis ran out of memory in prod.");
  miss("ex-redis", /Redis/i.test(texts(mem)));
  mem.close();
}

{
  const mem = openMemory({ dir: tmp() });
  for (const d of DISTRACTORS) mem.observe([{ role: "user", content: d }]);
  miss("ret-tz-hours", /Pacific/i.test(top(mem, "What hours is Kai in?")));
  miss("ret-house-ui", /dark mode/i.test(top(mem, "What's the house style for the UI?")));
  miss("ret-cache-die", /Redis/i.test(top(mem, "Why did the cache die last week?")));
  miss("ret-dsn-para", /staging\.internal/i.test(top(mem, "How do I connect the staging database?")));
  miss("ret-oncall", /PagerDuty/i.test(top(mem, "Who pages if Eden-API burns at 3am?")));
  miss("ret-image", /distroless/i.test(top(mem, "What base should the production container use?")));
  miss("ret-ci", /depot\.dev/i.test(top(mem, "Where do GitHub checks actually build?")));
  miss("ret-reviewers", /two reviewers/i.test(top(mem, "Can I merge this PR with one approval?")));
  miss("ret-standup", /eng-standup/i.test(top(mem, "Where does the team stand up in the morning?")));
  miss("ret-due", /2026-09-30/.test(top(mem, "When is the compliance evidence pack due?")));
  miss("ret-flag", /billing_v2/i.test(top(mem, "Which feature flag gates the new checkout?")));
  miss("ret-rps", /40 rps/i.test(top(mem, "What is the complete endpoint rate limit?")));
  miss("ret-tabs", /tabs/i.test(top(mem, "Spaces or tabs for this user?")));
  miss("ret-namespace", /eden-prod/i.test(top(mem, "Which k8s namespace is production?")));
  const k1 = mem.notesFor("What hours is Kai in?", 1).map((m) => m.text).join("\n");
  miss("ret-tz-not-billing", /Pacific/i.test(k1) && !/billing service/i.test(k1));
  mem.close();
}

{
  const cap = wikiCapital(KENYA, KENYA_INFOBOX, "");
  miss("kn-wiki-cap", !!(cap && cap.s === "Kenya" && cap.o === "Nairobi"));
  const t = triplesFromPage(KENYA, `<html>${KENYA_INFOBOX}</html>`, true);
  miss("kn-triples-cap", t.some((x) => x.s === "Kenya" && x.p === "capital" && x.o === "Nairobi"));
}

{
  const t = triplesFromPage("https://www.rfc-editor.org/rfc/rfc9110.html", RFC_HTML, true);
  miss("kn-rfc-title", t.some((x) => x.s === "RFC 9110" && /HTTP Semantics/i.test(x.o)));
  miss("kn-rfc-edge", t.some((x) => /obsoletes/i.test(x.p) && /7230/.test(x.o)));
}

{
  const t = triplesFromPage("https://bun.sh/", BUN_HTML, true);
  miss("kn-soft-bun", t.some((x) => /Bun/i.test(x.s) && /runtime/i.test(x.o + (x.e || ""))));
}

{
  const t = triplesFromPage("https://jqlang.github.io/jq/", LD_HTML, true);
  miss("kn-ld-jq", t.some((x) => /jq/i.test(x.s) && /JSON/i.test(x.o + (x.e || ""))));
}

{
  const t = techniquesFromProse("ripgrep is used for searching code quickly.");
  miss("kn-tech-rg", t.some((x) => /ripgrep/i.test(x.s) && /searching code/i.test(x.o)));
}

{
  const t = techniquesFromProse("Use jq to filter JSON on the command line.");
  miss("kn-tech-jq", t.some((x) => x.s === "jq" && /JSON/i.test(x.o)));
}

{
  const card = knowQuery("capital of Kenya");
  const fact = "fact" in card ? card.fact : "";
  miss("kq-kenya", /Nairobi/i.test(fact));
}

{
  const card = knowQuery("Kenya's capital");
  const fact = "fact" in card ? card.fact : "";
  miss("kq-kenya-s", /Nairobi/i.test(fact));
}

{
  const card = knowQuery("RFC 9110");
  const fact = "fact" in card ? card.fact : "";
  miss("kq-rfc9110", /HTTP Semantics/i.test(fact));
}

{
  const card = knowQuery("what is jq used for");
  const fact = "fact" in card ? card.fact : "";
  miss("kq-jq", /JSON/i.test(fact) && /jq/i.test(fact));
}

{
  const mem = openMemory({ dir: tmp() });
  mem.observe([{ role: "user", content: "Kai's timezone is Pacific" }]);
  const hits = mem.query("capital of Kenya", 6);
  miss("q-know-mix", hits.some((h) => /Nairobi/i.test(h.text)));
  mem.close();
}

const JUNK_CHAT = [
  "ok thanks",
  "can you fix the flaky test",
  "let me look at this",
  "cool, shipping it",
  "```ts\nconst x = 1\n```",
  "https://example.com/docs",
  "sk-abcdefghijklmnopqrstuvwxyz012345",
  "leftover intern firm notes",
];

for (const s of JUNK_CHAT) {
  const mem = absorb(s);
  if (mem.memories().length) junk += 1;
  mem.close();
}

{
  const card = knowQuery("asdf qwerty zxcv not a real protocol");
  if ("fact" in card && card.fact) junk += 1;
}

{
  const card = injectFromText("can you fix the flaky test please");
  if (card) junk += 1;
}

{
  const t = triplesFromPage("https://en.wikipedia.org/wiki/Kenya", "<p>Click here to subscribe to our newsletter.</p>", true);
  if (t.some((x) => /subscribe|newsletter/i.test(x.o))) junk += 1;
}

const COST_HTML = `<html><head><title>RFC 9110: HTTP Semantics</title></head><body>
<table class="infobox"><tr><th>Capital</th><td>Nairobi</td></tr></table>
<p>Bun is a fast all-in-one JavaScript runtime. ripgrep is used for searching code quickly.</p>
</body></html>`;

function mixedBatch() {
  const mem = openMemory({ dir: tmp() });
  for (const d of DISTRACTORS) mem.observe([{ role: "user", content: d }]);
  mem.notesFor("What hours is Kai in?", 3);
  mem.notesFor("How do I connect the staging database?", 3);
  mem.query("capital of Kenya", 4);
  triplesFromPage(KENYA, COST_HTML, true);
  techniquesFromProse("ripgrep is used for searching code quickly. Use jq to filter JSON.");
  knowQuery("capital of Kenya");
  knowQuery("RFC 9110");
  mem.close();
}

mixedBatch();
const samples: number[] = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  for (let j = 0; j < 8; j++) mixedBatch();
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const costMs = Math.round(samples[2]! / 20) * 20;

for (const d of [tmp(), tmp()]) rmSync(d, { recursive: true, force: true });

console.log(`metric: ${misses.length}`);
console.log(`junk: ${junk}`);
console.log(`cost_ms: ${costMs}`);
if (misses.length) console.error(`missed ${misses.join(",")}`);
