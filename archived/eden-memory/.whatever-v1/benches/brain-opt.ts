/**
 * Locked brain-opt bakeoff. Do not edit after lock.
 *
 * Deep primary: equal-weight miss mass across
 *   eng / personal / update / know  (Eden AgentMemory product path)
 *   eden5 / brain5 / brain20        (LoCoMo retrieve evidence)
 * so neither extract-only nor store-all can hide failures.
 *
 * stdout:
 *   metric: sum of round(1000 * miss_rate) over families   lower
 *   junk: false stores                                       lower
 *   losses: families where a baseline beats Eden/Brain       lower
 *   cost_ms: mixed-batch median, 20ms buckets                lower
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, type AgentMemory } from "../../src/index";
import { BrainMemory } from "../../src/brain-memory";
import { injectFromText } from "../../packages/know/src/inject";
import { knowQuery } from "../../packages/know/src/query";

const ROOT = mkdtempSync(join(tmpdir(), "brain-opt-"));
const K = 5;
const K20 = 20;
const LOCOMO = process.env.LOCOMO_PATH || "/tmp/eden-mem-bakeoff/locomo10.json";
const LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";
const MAX_CONV = Number(process.env.EDEN_BRAIN_OPT_CONV || "10");

type Want = RegExp | RegExp[];
const STOP = new Set("the of is a an on to and in for this that with from into about these then still has out how what why was are you your its our not or no".split(" "));

function toks(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2 && !STOP.has(w));
}
function hitsWant(got: string, want: Want): boolean {
  return Array.isArray(want) ? want.every((re) => re.test(got)) : want.test(got);
}
function goldHit(retrieved: string, answer: string): boolean {
  const a = String(answer || "").toLowerCase().trim();
  const r = retrieved.toLowerCase();
  if (!a) return false;
  if (r.includes(a)) return true;
  if (a.length <= 8) return false;
  const t = toks(a);
  return t.length > 0 && t.every((w) => r.includes(w));
}
function bm25(query: string, docs: string[], k: number): string[] {
  const N = docs.length || 1;
  const dl = docs.map((d) => Math.max(1, toks(d).length));
  const avgdl = dl.reduce((a, b) => a + b, 0) / N;
  const df = new Map<string, number>();
  const tfs = docs.map((d) => {
    const m = new Map<string, number>();
    for (const w of toks(d)) m.set(w, (m.get(w) || 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    return m;
  });
  const q = toks(query);
  const k1 = 1.5, b = 0.75;
  return docs
    .map((d, i) => {
      let s = 0;
      const tf = tfs[i]!;
      for (const w of q) {
        const n = tf.get(w) || 0;
        if (!n) continue;
        const idf = Math.log((N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5) + 1);
        s += idf * ((n * (k1 + 1)) / (n + k1 * (1 - b + b * (dl[i]! / avgdl))));
      }
      return { d, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.d);
}

const DISTRACTORS = [
  "Standup moved to 10am Pacific.",
  "Prefer bun over node for scripts.",
  "Never commit .env files.",
  "Redis is the session cache.",
  "PagerDuty routes sev1 to oncall.",
  "The deploy window is Tuesday 16:00 UTC.",
  "Use Conventional Commits.",
  "Feature flag launchdarkly-checkout-v2 is off.",
  "Sentry DSN lives in 1Password.",
  "Staging VPC is 10.8.0.0/16.",
];

const JUNK = ["lol", "ok", "thanks", "hmm", "asdf qwerty", "```\ncode\n```", "https://example.com/x", "{}"];

type Row = { id: string; stated: string[]; asked: string; want: Want };

const ENG: Row[] = [
  { id: "tz", stated: ["Kai prefers Pacific hours."], asked: "What hours is Kai in?", want: /pacific/i },
  { id: "redis", stated: ["We use Redis for the session cache."], asked: "What stores sessions?", want: /redis/i },
  { id: "bun", stated: ["Prefer bun over node for scripts."], asked: "Which runtime for scripts?", want: /bun/i },
  { id: "pd", stated: ["PagerDuty routes sev1 to oncall."], asked: "Who gets sev1 pages?", want: /oncall|pagerduty/i },
  { id: "flag", stated: ["Feature flag launchdarkly-checkout-v2 is off."], asked: "Is checkout v2 on?", want: /off|launchdarkly/i },
  { id: "vpc", stated: ["Staging VPC is 10.8.0.0/16."], asked: "Staging VPC CIDR?", want: /10\.8\.0\.0/ },
  { id: "ci", stated: ["CI checks must pass before merge."], asked: "What must pass before merge?", want: /ci|checks/i },
  { id: "env", stated: ["Never commit .env files."], asked: "Can we commit env files?", want: /never|\.env/i },
];

const PERSONAL: Row[] = [
  { id: "veg", stated: ["Sam is vegetarian."], asked: "Dietary constraint for Sam?", want: /vegetarian/i },
  { id: "dog", stated: ["Our dog is named Maple."], asked: "Dog's name?", want: /maple/i },
  { id: "live", stated: ["I live in Austin."], asked: "Where do I live?", want: /austin/i },
  { id: "work", stated: ["I work at Neon."], asked: "Where do I work?", want: /neon/i },
  { id: "dairy", stated: ["Skip dairy for Alex."], asked: "Alex food constraint?", want: /dairy/i },
  { id: "tz2", stated: ["Maya is on Eastern time."], asked: "Maya timezone?", want: /eastern/i },
  { id: "stay", stated: ["Jordan stays in Seattle most weeks."], asked: "Where does Jordan stay?", want: /seattle/i },
  { id: "terse", stated: ["Pat prefers brief replies."], asked: "How should I write to Pat?", want: /brief/i },
];

const UPDATE: Row[] = [
  { id: "cache", stated: ["Cache is memcached.", "Cache is Redis now."], asked: "What is the cache?", want: /redis/i },
  { id: "owner", stated: ["API owned by Lee.", "API owned by Sam."], asked: "Who owns the API?", want: /sam/i },
  { id: "region", stated: ["Primary region us-east-1.", "Primary region eu-west-1."], asked: "Primary region?", want: /eu-west-1/i },
  { id: "branch", stated: ["Ship from main.", "Ship from release."], asked: "Ship branch?", want: /release/i },
];

const KNOW_Q = [
  { id: "kenya", q: "capital of Kenya", want: /nairobi/i },
  { id: "rfc", q: "RFC 9110", want: /HTTP Semantics|http semantics/i },
  { id: "jq", q: "what is jq used for", want: /json/i },
  { id: "bun", q: "bun used for", want: /javascript|runtime|js/i },
  { id: "tls", q: "RFC 8446", want: /TLS|tls/i },
];

function captureFamily(memFactory: () => AgentMemory, rows: Row[], tag: string): number {
  let miss = 0;
  for (const row of rows) {
    const dir = join(ROOT, tag, row.id, Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    const mem = openMemory({ dir });
    for (const s of row.stated) mem.observe([{ role: "user", content: s }]);
    for (const d of DISTRACTORS) mem.observe([{ role: "user", content: d }]);
    const inj = mem
      .inject([{ role: "user", content: row.asked }])
      .filter((m) => m && typeof m === "object" && (m as { role?: string }).role === "system")
      .map((m) => String((m as { content?: string }).content || ""))
      .join("\n");
    if (!hitsWant(inj, row.want)) miss++;
    mem.close();
  }
  return miss;
}

type Turn = { text: string; speaker: string; date: string; session: number; at: number };

function locomoTurns(conv: Record<string, unknown>): Turn[] {
  const out: Turn[] = [];
  let at = 0;
  for (let n = 1; n <= 40; n++) {
    const date = String(conv[`session_${n}_date_time`] || "").trim();
    const sess = conv[`session_${n}`];
    if (!Array.isArray(sess)) continue;
    for (const turn of sess as { text?: string; speaker?: string }[]) {
      const text = String(turn?.text || "").trim();
      if (!text) continue;
      out.push({ text, speaker: String(turn?.speaker || "speaker"), session: n, date, at: at++ });
    }
  }
  return out;
}

async function loadLocomo() {
  if (!existsSync(LOCOMO)) {
    mkdirSync(join(LOCOMO, ".."), { recursive: true });
    const res = await fetch(LOCOMO_URL);
    if (!res.ok) return null;
    writeFileSync(LOCOMO, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(readFileSync(LOCOMO, "utf8")) as {
    conversation: Record<string, unknown>;
    qa: { question: string; answer: string; category: number }[];
  }[];
}

function locomoMissEden(data: NonNullable<Awaited<ReturnType<typeof loadLocomo>>>): { miss: number; n: number } {
  let miss = 0, n = 0;
  for (const sample of data.slice(0, MAX_CONV)) {
    const dir = join(ROOT, "lo-eden", Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    const mem = openMemory({ dir });
    for (const t of locomoTurns(sample.conversation)) {
      mem.observe([{ role: "user", content: `${t.speaker}: ${t.text}` }]);
    }
    for (const qa of sample.qa) {
      if (qa.category === 5) continue;
      n++;
      if (!goldHit(mem.notesFor(qa.question, K).map((m) => m.text).join("\n"), qa.answer)) miss++;
    }
    mem.close();
  }
  return { miss, n };
}

function locomoMissBrain(
  data: NonNullable<Awaited<ReturnType<typeof loadLocomo>>>,
  k: number,
): { miss: number; n: number } {
  let miss = 0, n = 0;
  for (const sample of data.slice(0, MAX_CONV)) {
    const brain = new BrainMemory();
    brain.ingestTurns(locomoTurns(sample.conversation));
    for (const qa of sample.qa) {
      if (qa.category === 5) continue;
      n++;
      if (!goldHit(brain.retrieve(qa.question, k).join("\n"), qa.answer)) miss++;
    }
    brain.close();
  }
  return { miss, n };
}

function locomoMissBm25(data: NonNullable<Awaited<ReturnType<typeof loadLocomo>>>): { miss: number; n: number } {
  let miss = 0, n = 0;
  for (const sample of data.slice(0, MAX_CONV)) {
    const docs = locomoTurns(sample.conversation).map(
      (t) => `${t.speaker}:${t.date ? ` [${t.date}]` : ""} ${t.text}`.replace(/\s+/g, " ").trim(),
    );
    for (const qa of sample.qa) {
      if (qa.category === 5) continue;
      n++;
      if (!goldHit(bm25(qa.question, docs, K).join("\n"), qa.answer)) miss++;
    }
  }
  return { miss, n };
}

function knowMiss(): { miss: number; n: number } {
  let miss = 0;
  for (const row of KNOW_Q) {
    const card = knowQuery(row.q);
    const got = card && "fact" in card ? String(card.fact) : "";
    if (!row.want.test(got)) miss++;
  }
  const injOk = !injectFromText("can you fix the flaky test please");
  const injAsdf = !injectFromText("asdf qwerty zxcv not a real protocol");
  const n = KNOW_Q.length + 2;
  miss += injOk ? 0 : 1;
  miss += injAsdf ? 0 : 1;
  return { miss, n };
}

function junkCount(): number {
  let bad = 0;
  for (const s of JUNK) {
    const dir = join(ROOT, "j", String(bad) + Math.random());
    mkdirSync(dir, { recursive: true });
    const mem = openMemory({ dir });
    mem.observe([{ role: "user", content: s }]);
    const stored = mem.memories().join("\n").toLowerCase();
    const probe = s.length >= 8 ? s.slice(0, 18).toLowerCase() : s.toLowerCase();
    if (probe && stored.includes(probe)) bad++;
    mem.close();
  }
  return bad;
}

function mixedCost(): number {
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const dir = join(ROOT, "cost", String(i));
    mkdirSync(dir, { recursive: true });
    const mem = openMemory({ dir });
    const brain = new BrainMemory();
    const t0 = performance.now();
    for (const d of DISTRACTORS) mem.observe([{ role: "user", content: d }]);
    brain.ingestTexts(DISTRACTORS);
    mem.notesFor("What hours is Kai in?", 3);
    brain.retrieve("What hours is Kai in?", 3);
    knowQuery("RFC 9110");
    mem.close();
    brain.close();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[2]! / 20) * 20;
}

const locomo = await loadLocomo();
if (!locomo) {
  console.log("metric: 99999");
  console.log("junk: 99");
  console.log("losses: 99");
  console.log("cost_ms: 99999");
  process.exit(0);
}

const eng = captureFamily(() => openMemory({ dir: join(ROOT, "e") }), ENG, "eng");
const personal = captureFamily(() => openMemory({ dir: join(ROOT, "p") }), PERSONAL, "per");
const update = captureFamily(() => openMemory({ dir: join(ROOT, "u") }), UPDATE, "upd");
const know = knowMiss();
const eden5 = locomoMissEden(locomo);
const brain5 = locomoMissBrain(locomo, K);
const brain20 = locomoMissBrain(locomo, K20);
const bm25b = locomoMissBm25(locomo);
const junk = junkCount();
const cost_ms = mixedCost();

const sizes = {
  eng: ENG.length,
  personal: PERSONAL.length,
  update: UPDATE.length,
  know: know.n,
  eden5: eden5.n || 1,
  brain5: brain5.n || 1,
  brain20: brain20.n || 1,
};

const misses = {
  eng,
  personal,
  update,
  know: know.miss,
  eden5: eden5.miss,
  brain5: brain5.miss,
  brain20: brain20.miss,
};

let metric = 0;
for (const [k, miss] of Object.entries(misses)) {
  const n = sizes[k as keyof typeof sizes];
  metric += Math.round((1000 * miss) / n);
}

// losses: baselines beating us on comparable lanes
let losses = 0;
if (bm25b.miss < eden5.miss) losses++; // extract bug signal
if (bm25b.miss < brain5.miss) losses++;

try {
  rmSync(ROOT, { recursive: true, force: true });
} catch {}

console.log(`metric: ${metric}`);
console.log(`junk: ${junk}`);
console.log(`losses: ${losses}`);
console.log(`cost_ms: ${cost_ms}`);
console.error(JSON.stringify({ sizes, misses, bm25: bm25b, metric, junk, losses, cost_ms }));
