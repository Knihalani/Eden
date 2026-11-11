#!/usr/bin/env bun
/**
 * M2's synthetic-world factory (D880–D884), LAB ONLY. Nothing in a product package imports this file.
 *
 *   bun packages/sim/src/lab/synth/gen.ts families [--per 14] [--mode direct|batch]
 *   bun packages/sim/src/lab/synth/gen.ts plan --worlds N             (adds plans N worlds long, deterministic)
 *   bun packages/sim/src/lab/synth/gen.ts worlds [--mode direct|batch] [--limit N]
 *   bun packages/sim/src/lab/synth/gen.ts tasks [--mode direct|batch] [--limit N]
 *   bun packages/sim/src/lab/synth/gen.ts revise [--mode direct|batch] (the writer re-checks each task, D883)
 *   bun packages/sim/src/lab/synth/gen.ts assemble [--no-revise]      (validate, QC, write worlds/<split>.jsonl)
 *   common: [--dir .local/m2/synth] [--spend-ledger .local/m2/ledger.jsonl] [--spend-cap 60] [--concurrency 24]
 *
 * Families are abstract scenarios (area × archetype × angle, Haiku, no names), deduped against each other and the
 * train suites and clustered; the cluster's hash fixes its split, and a world draws all its families from one split,
 * so a test world's templates are templates no train world saw (D491's failure was exactly that generalisation). A
 * world is one Haiku call (persona, people, background) and one call a task; labels come from construction.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rng } from "../../rng";
import { emailText } from "../../text";
import { SpendLedger } from "../spend";
import { dropResult, parseJson, readResult, runBatch, runDirect, type Job } from "./jobs";
import {
  ANGLES,
  FAMILY_SYSTEM,
  TIMING_TEXT,
  dayName,
  familyPrompt,
  revisePrompt,
  reviseSystem,
  taskPrompt,
  taskSystem,
  worldPrompt,
  worldSystem,
  type WorldSeed,
} from "./prompts";
import { jaccard, leaks, qcFamilies, shingles, splitOfCluster, trainCorpus, type TrainTemplate } from "./qc";
import { FamilySchema, validateWorld, type Family, type SynthItem, type SynthTask, type SynthWorld } from "./schema";
import { countPairs } from "./labels";
import {
  AREAS,
  ARCHETYPE_NAMES,
  LANGS,
  RARE_SOURCES,
  STYLES,
  SYNTH_NOW,
  TIMING_SHARE,
  type Area,
  type Timing,
} from "./taxonomy";

const args = process.argv.slice(2);
const opt = (name: string, d = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : d;
};
const DIR = opt("dir", ".local/m2/synth");
const DAY = 86_400_000;
const HOUR = 3_600_000;
mkdirSync(DIR, { recursive: true });

const readJsonl = <T>(f: string): T[] =>
  existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T)
    : [];
const writeJsonl = (f: string, rows: unknown[]) => writeFileSync(f, rows.map((r) => JSON.stringify(r) + "\n").join(""));

function ledger() {
  return new SpendLedger(
    opt("spend-ledger", ".local/m2/ledger.jsonl"),
    Number(opt("spend-cap", "60")),
    opt("run-label", "m2-synth"),
    0.25,
  );
}
async function run(jobs: Job[]) {
  const l = ledger();
  const limit = Number(opt("limit", "0"));
  const js = limit > 0 ? jobs.slice(0, limit) : jobs;
  const t0 = Date.now();
  const r =
    opt("mode", "direct") === "batch"
      ? await runBatch(DIR, js, l, Number(opt("chunk", "4000")))
      : await runDirect(DIR, js, l, Number(opt("concurrency", "24")));
  console.log(
    `${js.length} jobs: ${JSON.stringify(r)} in ${((Date.now() - t0) / 1000).toFixed(0)} s; ledger $${l.committedUsd.toFixed(4)}`,
  );
}

// -----------------------------------------------------------------------------------------------------------------
// Families.

const familyJobs = (per: number, avoid: string[]): Job[] =>
  AREAS.flatMap((area) =>
    ARCHETYPE_NAMES.flatMap((arch) =>
      ANGLES.map((angle, a) => ({
        key: `fam/${area}/${arch}/${a}`,
        role: "m2.families",
        system: FAMILY_SYSTEM,
        user: familyPrompt(area, arch, per, angle, avoid),
        maxTokens: 9_000,
      })),
    ),
  );

async function families() {
  const train = trainCorpus();
  const jobs = familyJobs(Number(opt("per", "14")), [...new Set(train.map((t) => t.template))]);
  if (!args.includes("--qc-only")) await run(jobs);
  const raw: Family[] = [];
  let bad = 0;
  for (const j of jobs) {
    const r = readResult(DIR, j.key);
    if (!r) continue;
    const [, area, archetype] = j.key.split("/");
    try {
      const got = (parseJson(r.text) as { families: Record<string, string>[] }).families;
      got.forEach((g) => {
        const slug = String(g.slug ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 48);
        const f = FamilySchema.safeParse({ ...g, id: `f-${area}-${slug}`, area, archetype });
        if (f.success) raw.push(f.data);
        else bad++;
      });
    } catch {
      bad++;
      dropResult(DIR, j.key);
    }
  }
  // Same slug twice in an area: the later one gets a suffix so ids stay unique.
  const seen = new Map<string, number>();
  for (const f of raw) {
    const n = seen.get(f.id) ?? 0;
    seen.set(f.id, n + 1);
    if (n) f.id = `${f.id}-${n + 1}`;
  }
  const qc = qcFamilies(raw, train);
  const kept = qc.kept.map((f) => ({ ...f, split: splitOfCluster(f.cluster) }));
  writeJsonl(join(DIR, "families.jsonl"), kept);
  const by = (k: (f: (typeof kept)[number]) => string) =>
    kept.reduce<Record<string, number>>((m, f) => ((m[k(f)] = (m[k(f)] ?? 0) + 1), m), {});
  const report = {
    raw: raw.length,
    invalid: bad,
    nearTrain: qc.nearTrain.length,
    nearFamily: qc.nearFamily.length,
    kept: kept.length,
    clusters: new Set(kept.map((f) => f.cluster)).size,
    split: by((f) => f.split),
    decoyKind: by((f) => f.decoyKind),
    nearTrainExamples: qc.nearTrain.slice(0, 20),
    nearFamilyExamples: qc.nearFamily.slice(0, 20),
  };
  writeFileSync(join(DIR, "families-qc.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, nearTrainExamples: undefined, nearFamilyExamples: undefined }));
}

// -----------------------------------------------------------------------------------------------------------------
// Plans: which families, timings, sources and languages each world gets. Deterministic in the world's index.

type Fam = Family & { cluster: string; split: "train" | "val" | "test" };
interface TaskPlan {
  task: string;
  family: string;
  timing: Timing;
  source: string;
  foreign: string | null;
  requestAt: number;
  factAt: number | null;
  followAt: number | null;
  decoyDay: number;
}
interface Plan {
  id: string;
  index: number;
  split: "train" | "val" | "test";
  seed: WorldSeed;
  tasks: TaskPlan[];
}

const REGIONS = [
  "Leeds, UK",
  "Bristol, UK",
  "Glasgow, Scotland",
  "Cardiff, Wales",
  "London, UK",
  "Manchester, UK",
  "Dublin, Ireland",
  "Cork, Ireland",
  "Toronto, Canada",
  "Vancouver, Canada",
  "Austin, Texas",
  "Chicago, Illinois",
  "Portland, Oregon",
  "Boston, Massachusetts",
  "Atlanta, Georgia",
  "Melbourne, Australia",
  "Brisbane, Australia",
  "Auckland, New Zealand",
  "Bengaluru, India",
  "Mumbai, India",
  "Singapore",
  "Berlin, Germany (expat)",
  "Amsterdam, Netherlands (expat)",
  "Lisbon, Portugal (expat)",
  "Cape Town, South Africa",
  "a village in Devon, UK",
  "rural Vermont, USA",
];
const AGES = ["19-24", "25-31", "32-39", "40-48", "49-58", "59-67", "68-78"];
const HOUSEHOLDS = [
  "lives alone",
  "lives with a partner",
  "partner and two young children",
  "single parent of a teenager",
  "shares a flat with two housemates",
  "partner, one baby and a dog",
  "cares for an elderly parent at home",
  "grown-up children have left; lives with spouse",
  "lives with partner and a stepchild every other week",
  "student in halls",
  "lives with parents while saving",
  "partner and three school-age children",
];
const WORK = [
  "nurse on rotating shifts",
  "secondary-school teacher",
  "freelance graphic designer",
  "software engineer",
  "account manager at a SaaS firm",
  "owns a small café",
  "retired civil servant",
  "warehouse supervisor",
  "solicitor",
  "PhD student",
  "delivery driver (self-employed)",
  "head of operations at a charity",
  "electrician",
  "sales director",
  "GP receptionist",
  "management consultant",
  "stay-at-home parent",
  "university lecturer",
  "pharmacist",
  "product manager",
  "estate agent",
  "chef",
  "accountant",
  "physiotherapist",
  "civil engineer",
];
const COMMON_FOR: Record<Area, string[]> = {
  work: ["gmail", "slack", "calendar", "drive", "crm"],
  family: ["gmail", "calendar", "drive"],
  health: ["gmail", "calendar", "drive"],
  money: ["gmail", "drive", "calendar"],
  travel: ["gmail", "calendar", "drive"],
  home: ["gmail", "calendar", "drive"],
  admin: ["gmail", "drive", "calendar"],
  social: ["gmail", "calendar", "slack"],
};
const RARE_FOR: Record<Area, string[]> = {
  work: ["tickets", "files", "notes", "tasks", "sms"],
  family: ["school", "whatsapp", "sms", "notes"],
  health: ["health", "notes", "sms"],
  money: ["bank", "files", "notes"],
  travel: ["whatsapp", "sms", "files", "notes"],
  home: ["household", "notes", "sms", "bank"],
  admin: ["files", "notes", "tasks", "bank"],
  social: ["whatsapp", "sms", "notes"],
};
/** Sources whose items are edited in place (a silent change needs one). */
const EDITABLE = new Set(["calendar", "drive", "crm", "notes", "tasks", "files", "tickets", "household"]);
const LETTERS = "ABCDEFGHIJKLMNOPRSTVWY";

function plan() {
  const fams = readJsonl<Fam>(join(DIR, "families.jsonl"));
  const plans = readJsonl<Plan>(join(DIR, "plans.jsonl"));
  const uses = new Map<string, number>();
  for (const p of plans) for (const t of p.tasks) uses.set(t.family, (uses.get(t.family) ?? 0) + 1);
  const n = Number(opt("worlds", "200"));
  const out: Plan[] = [];
  for (let k = plans.length; k < plans.length + n; k++) {
    const rng = new Rng(9_100_000 + k);
    const split: Plan["split"] = splitOfCluster(`world-${k}`);
    const id = `sw-${String(k).padStart(5, "0")}`;
    const tasks: TaskPlan[] = [];
    const rareUsed = new Set<string>();
    AREAS.forEach((area, ti) => {
      const pool = fams.filter((f) => f.split === split && f.area === area);
      if (!pool.length) return;
      // Least-used family first, ties broken by the world's own draw: every family is used before any is reused.
      const min = Math.min(...pool.map((f) => uses.get(f.id) ?? 0));
      const least = pool.filter((f) => (uses.get(f.id) ?? 0) === min);
      const f = rng.pick(least);
      uses.set(f.id, min + 1);
      const r = rng.next();
      const timing: Timing =
        r < TIMING_SHARE.silent
          ? "silent"
          : r < TIMING_SHARE.silent + TIMING_SHARE.late
            ? "late"
            : r < TIMING_SHARE.silent + TIMING_SHARE.late + TIMING_SHARE.multiday
              ? "multiday"
              : "static";
      // About a quarter of facts live in a rarely used source. Families name one about half the time (pilot: 64% of
      // tasks rare when every such family kept it), so a family's rare source is kept 40% of the time and a common
      // one moves to a rare source that fits the area 12% of the time.
      const fit = COMMON_FOR[area].includes(f.source) ? f.source : rng.pick(COMMON_FOR[area]);
      let source = f.source in RARE_SOURCES && rng.chance(0.4) ? f.source : fit;
      if (!(source in RARE_SOURCES) && rng.chance(0.12)) source = rng.pick(RARE_FOR[area]);
      if (timing === "silent" && !EDITABLE.has(source))
        source = rng.pick([...RARE_FOR[area], ...COMMON_FOR[area]].filter((s) => EDITABLE.has(s)));
      if (source in RARE_SOURCES) rareUsed.add(source);
      const requestAt = SYNTH_NOW + 30 * 60_000 + ti * 40 * 60_000;
      const factAt =
        timing === "late"
          ? requestAt + rng.int(90, 300) * 60_000
          : timing === "multiday"
            ? SYNTH_NOW + DAY + rng.int(4, 8) * HOUR
            : timing === "silent"
              ? requestAt - rng.int(2, 40) * HOUR
              : null;
      tasks.push({
        task: `t${ti + 1}`,
        family: f.id,
        timing,
        source,
        foreign: rng.chance(0.5) ? rng.pick([...LANGS]) : null,
        requestAt,
        factAt,
        followAt: timing === "multiday" ? SYNTH_NOW + 2 * DAY + rng.int(1, 6) * HOUR : null,
        decoyDay: -rng.int(2, 45),
      });
    });
    // The world's background also uses each rare source its facts use, and one or two more, so a rare source is
    // never a tell on its own.
    const extra = rng.sample(
      Object.keys(RARE_SOURCES).filter((s) => !rareUsed.has(s)),
      rng.int(1, 2),
    );
    const fam = new Map(fams.map((f) => [f.id, f]));
    const work = rng.pick(WORK);
    const seed: WorldSeed = {
      region: rng.pick(REGIONS),
      age: rng.pick(AGES),
      household: rng.pick(HOUSEHOLDS),
      work,
      initials: `${rng.pick([...LETTERS])} and ${rng.pick([...LETTERS])}`,
      sources: [
        "gmail",
        "calendar",
        "drive",
        "slack",
        ...(/sales|account|consult|director|operations|estate/.test(work) ? ["crm"] : []),
        ...rareUsed,
        ...extra,
      ],
      reserved: tasks.map((t) => fam.get(t.family)!.situation),
      items: 26,
    };
    out.push({ id, index: k, split, seed, tasks });
  }
  for (const p of out) appendFileSync(join(DIR, "plans.jsonl"), JSON.stringify(p) + "\n");
  const by = out.reduce<Record<string, number>>((m, p) => ((m[p.split] = (m[p.split] ?? 0) + 1), m), {});
  console.log(`planned ${out.length} worlds (${plans.length} before): ${JSON.stringify(by)}`);
}

// -----------------------------------------------------------------------------------------------------------------
// World and task jobs.

const plans = () => {
  const ps = readJsonl<Plan>(join(DIR, "plans.jsonl"));
  const from = Number(opt("from", "0"));
  const to = Number(opt("to", String(ps.length)));
  return ps.filter((p) => p.index >= from && p.index < to);
};
const WORLD_SYSTEM = worldSystem();
const TASK_SYSTEM = taskSystem();

const worldJobs = (): Job[] =>
  plans().map((p) => ({
    key: `world/${p.id}`,
    role: "m2.world",
    system: WORLD_SYSTEM,
    user: worldPrompt(p.seed),
    maxTokens: 12_000,
  }));

interface RawItem {
  source?: string;
  kind?: string;
  title?: string;
  from?: string;
  text?: string;
  day?: number;
  time?: string;
  start?: string;
}
interface RawWorld {
  persona: { first: string; last: string; email: string; city: string; job: string; household: string };
  people: { full: string; email: string; relation: string; role?: string }[];
  items: RawItem[];
}
interface RawTask {
  detail: string;
  requests: { style: string; text: string }[];
  foreign: { lang: string; text: string } | null;
  followups: string[];
  fact: RawItem;
  decoy: RawItem;
  neutrals: RawItem[];
}

function rawWorld(p: Plan): RawWorld | undefined {
  const r = readResult(DIR, `world/${p.id}`);
  if (!r) return undefined;
  try {
    return parseJson(r.text) as RawWorld;
  } catch {
    return undefined;
  }
}

const at = (ms: number) => {
  const d = new Date(ms);
  return `${dayName(Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(2026, 9, 27)) / DAY))} at ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

function taskJobs(): Job[] {
  const fams = new Map(readJsonl<Fam>(join(DIR, "families.jsonl")).map((f) => [f.id, f]));
  const jobs: Job[] = [];
  for (const p of plans()) {
    const w = rawWorld(p);
    if (!w?.persona || !Array.isArray(w.items) || !Array.isArray(w.people)) continue;
    const persona = `${w.persona.first} ${w.persona.last} <${w.persona.email}>, ${w.persona.job}, ${w.persona.city}; ${w.persona.household}`;
    const people = w.people.map((x) => `${x.full} <${x.email}> (${x.role ?? x.relation})`).join("; ");
    for (const t of p.tasks) {
      const timing =
        t.timing === "static"
          ? TIMING_TEXT.static(dayName(t.decoyDay))
          : t.timing === "silent"
            ? TIMING_TEXT.silent(at(t.factAt!), t.source)
            : t.timing === "late"
              ? TIMING_TEXT.late(at(t.factAt!))
              : TIMING_TEXT.multiday(at(t.requestAt), at(t.factAt!), at(t.followAt!));
      jobs.push({
        key: `task/${p.id}/${t.task}`,
        role: "m2.task",
        system: TASK_SYSTEM,
        user: taskPrompt({
          persona,
          people,
          family: fams.get(t.family)!,
          timing,
          source: t.source in RARE_SOURCES ? `${t.source} (${RARE_SOURCES[t.source]!.description})` : t.source,
          foreign: t.foreign,
          followups: t.timing === "multiday",
          requestAt: at(t.requestAt),
        }),
        maxTokens: 6_000,
      });
    }
  }
  return jobs;
}

const REVISE_SYSTEM = reviseSystem();

function rawTask(p: Plan, task: string): RawTask | undefined {
  const r = readResult(DIR, `task/${p.id}/${task}`);
  if (!r) return undefined;
  try {
    const t = parseJson(r.text) as RawTask;
    return t?.fact && t.decoy && Array.isArray(t.requests) && Array.isArray(t.neutrals) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** One revision call a task whose reply parsed: the writer checks its own items against the audit's fault list. */
function reviseJobs(): Job[] {
  const jobs: Job[] = [];
  for (const p of plans()) {
    const raws = p.tasks.map((t) => ({ t, raw: rawTask(p, t.task) }));
    const first = (r?: RawTask) =>
      r?.requests.find((q) => q.style === "imperative")?.text ?? r?.requests[0]?.text ?? "";
    for (const { t, raw } of raws) {
      if (!raw) continue;
      jobs.push({
        key: `revise/${p.id}/${t.task}`,
        role: "m2.revise",
        system: REVISE_SYSTEM,
        user: revisePrompt({
          request: first(raw),
          detail: String(raw.detail ?? ""),
          timing: t.timing,
          fact: raw.fact,
          decoy: raw.decoy,
          neutrals: raw.neutrals.slice(0, 3),
          others: raws.filter((x) => x.t.task !== t.task && x.raw).map((x) => first(x.raw)),
        }),
        maxTokens: 5_000,
      });
    }
  }
  return jobs;
}

/** The task reply with its revision applied (an item the revision rewrote replaces the original, keeping its time). */
function revised(p: Plan, task: string, raw: RawTask, rej: Rejects): RawTask {
  const r = readResult(DIR, `revise/${p.id}/${task}`);
  if (!r) return raw;
  let v: { fact?: RawItem | null; decoy?: RawItem | null; neutrals?: (RawItem | null)[] };
  try {
    v = parseJson(r.text) as typeof v;
  } catch {
    rej["revise: unparsable (kept original)"] = (rej["revise: unparsable (kept original)"] ?? 0) + 1;
    return raw;
  }
  const keep = (orig: RawItem, next: RawItem | null | undefined, what: string) => {
    if (!next || typeof next !== "object" || !next.text) return orig;
    rej[`revise: ${what} rewritten`] = (rej[`revise: ${what} rewritten`] ?? 0) + 1;
    return { ...orig, ...next, source: orig.source, day: orig.day, time: orig.time };
  };
  return {
    ...raw,
    fact: keep(raw.fact, v.fact, "fact"),
    decoy: keep(raw.decoy, v.decoy, "decoy"),
    neutrals: raw.neutrals.map((n, i) => keep(n, v.neutrals?.[i], "neutral")),
  };
}

// -----------------------------------------------------------------------------------------------------------------
// Assembly: raw replies to validated worlds.

const KIND_OF: Record<string, SynthItem["kind"]> = {
  calendar: "event",
  drive: "doc",
  slack: "chat",
  ...Object.fromEntries(Object.entries(RARE_SOURCES).map(([k, v]) => [k, v.kind])),
};
const MAIL_KINDS = new Set(["mail", "notification", "newsletter", "promo"]);
const parseWho = (s: string | undefined) => {
  const m = /^\s*"?([^<"]+?)"?\s*<([^>]+)>/.exec(s ?? "");
  if (!m) return undefined;
  const full = m[1]!.trim();
  return { full, first: full.split(/\s+/)[0]!, email: m[2]!.trim() };
};

function timeOf(day: number | undefined, time: string | undefined): number {
  const d = Math.max(-700, Math.min(9, Math.round(Number(day ?? -3)) || 0));
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  const hh = m ? Math.min(23, Number(m[1])) : 10;
  const mm = m ? Math.min(59, Number(m[2])) : 0;
  return Date.UTC(2026, 9, 27 + d, hh, mm);
}

function toItem(raw: RawItem, id: string, persona: { full: string; first: string; email: string }, atMs?: number) {
  const source = String(raw.source ?? "").toLowerCase();
  if (!["gmail", "calendar", "drive", "slack", "crm", ...Object.keys(RARE_SOURCES)].includes(source)) return undefined;
  if (!raw.text || !raw.title) return undefined;
  const t = atMs ?? timeOf(raw.day, raw.time);
  const kind: SynthItem["kind"] =
    source === "gmail"
      ? MAIL_KINDS.has(String(raw.kind))
        ? (raw.kind as SynthItem["kind"])
        : "mail"
      : source === "crm"
        ? raw.kind === "contact"
          ? "contact"
          : "deal"
        : KIND_OF[source]!;
  const from = parseWho(raw.from);
  const item: SynthItem = { id, source, kind, title: String(raw.title).slice(0, 200), text: String(raw.text), at: t };
  if (source === "gmail" && from) {
    item.text = emailText(from, persona, t, String(raw.text));
    if (from.email !== persona.email) item.meta = { people: `${from.full} <${from.email}>` };
  }
  if (kind === "event") {
    const s = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(raw.start ?? "");
    item.meta = { start: s ? `${s[0]}:00Z` : new Date(t).toISOString() };
  }
  item.text = item.text.slice(0, 4_000);
  return item;
}

interface Rejects {
  [reason: string]: number;
}

function assembleWorld(
  p: Plan,
  fams: Map<string, Fam>,
  train: { sets: Set<string>[]; names: string[] },
  rej: Rejects,
  notes: Record<string, unknown>[],
): SynthWorld | undefined {
  const bump = (r: string) => (rej[r] = (rej[r] ?? 0) + 1);
  const w = rawWorld(p);
  if (!w?.persona?.first || !Array.isArray(w.items) || !Array.isArray(w.people)) {
    bump("world: unparsable");
    return undefined;
  }
  const persona = {
    first: String(w.persona.first),
    last: String(w.persona.last),
    email: String(w.persona.email),
    city: String(w.persona.city ?? ""),
    job: String(w.persona.job ?? ""),
    household: String(w.persona.household ?? ""),
  };
  const me = { full: `${persona.first} ${persona.last}`, first: persona.first, email: persona.email };
  const items: SynthItem[] = [];
  let n = 0;
  for (const raw of w.items) {
    const it = toItem(raw, `i${++n}`, me);
    if (!it) {
      bump(`background item: invalid (${String(raw?.source)})`);
      continue;
    }
    // "day" read as the event's own date: the item was made before today (its start stays where it was).
    if (it.at > SYNTH_NOW) it.at = SYNTH_NOW - (1 + (n % 9)) * DAY - (n % 7) * HOUR;
    items.push(it);
  }
  // Names of the world's people and the persona: a request naming them leaks nothing.
  const known = new Set(
    [persona.first, persona.last, ...w.people.flatMap((x) => String(x?.full ?? "").split(/\s+/))].filter(Boolean),
  );
  const tasks: SynthTask[] = [];
  let usd = readResult(DIR, `world/${p.id}`)!.usd;
  let calls = 1;
  for (const tp of p.tasks) {
    const r = readResult(DIR, `task/${p.id}/${tp.task}`);
    if (!r) {
      bump("task: missing");
      continue;
    }
    usd += r.usd;
    calls++;
    let raw: RawTask;
    try {
      raw = parseJson(r.text) as RawTask;
    } catch {
      bump("task: unparsable");
      continue;
    }
    if (!raw?.fact || !raw.decoy || !Array.isArray(raw.requests) || !Array.isArray(raw.neutrals)) {
      bump("task: incomplete");
      continue;
    }
    if (!args.includes("--no-revise")) {
      raw = revised(p, tp.task, raw, rej);
      const rv = readResult(DIR, `revise/${p.id}/${tp.task}`);
      if (rv) ((usd += rv.usd), calls++);
    }
    // The writer sometimes reasons aloud in the detail ("... wait, correction", "the scenario family must be
    // adapted"): v1's audit found such tasks incoherent, so they are dropped (1.1% of v1's tasks).
    if (
      /\.\.\.\s*wait\b|\bwait,|\bhmm\b|doesn't fit|does not fit|scenario family|adapted for this|the parallel is/i.test(
        String(raw.detail),
      )
    ) {
      bump("task: writer reasoning in the detail");
      continue;
    }
    const f = fams.get(tp.family)!;
    // The fact's source and time are the plan's (the timing is built in), whatever the reply wrote.
    const factRaw = { ...raw.fact, source: tp.source };
    const fact = toItem(factRaw, `i${++n}`, me, tp.factAt ?? undefined);
    const decoy = toItem(
      tp.timing === "silent" ? { ...raw.decoy, source: tp.source } : raw.decoy,
      `i${++n}`,
      me,
      tp.timing === "silent" ? Math.min(timeOf(raw.decoy.day, raw.decoy.time), tp.factAt! - DAY) : undefined,
    );
    const neutrals = raw.neutrals
      .slice(0, 3)
      .map((x) => toItem(x, `i${++n}`, me))
      .filter((x): x is SynthItem => !!x && x.at <= SYNTH_NOW);
    if (!fact || !decoy || !neutrals.length) {
      bump("task: invalid item");
      continue;
    }
    // A decoy that repeats the fact word for word is no twin (pilot: one in 300 critic probes).
    const norm = (x: SynthItem) => `${x.title}\n${x.text}`.replace(/\s+/g, " ").trim().toLowerCase();
    if (norm(fact) === norm(decoy) || fact.text.replace(/\s+/g, " ") === decoy.text.replace(/\s+/g, " ")) {
      bump("task: decoy repeats the fact");
      continue;
    }
    // A static or silent fact sits before the request; one Haiku dated later is pulled back to the morning.
    if (tp.timing === "static" && fact.at > tp.requestAt) fact.at = SYNTH_NOW - 2 * HOUR;
    if (decoy.at > tp.requestAt) decoy.at = SYNTH_NOW - 26 * HOUR;
    if (tp.timing === "silent") fact.revisionOf = decoy.id;
    const others = [decoy.text, decoy.title, ...neutrals.map((x) => `${x.title}\n${x.text}`)];
    const reqs: { style: string; lang: string; text: string; at: number }[] = [];
    const styles = new Set(Object.keys(STYLES));
    for (const q of raw.requests)
      if (styles.has(q.style) && typeof q.text === "string" && q.text.trim())
        reqs.push({ style: q.style, lang: "en", text: q.text.trim(), at: tp.requestAt });
    if (raw.foreign?.text && tp.foreign)
      reqs.push({ style: "foreign", lang: tp.foreign, text: String(raw.foreign.text).trim(), at: tp.requestAt });
    if (tp.timing === "multiday")
      for (const x of (raw.followups ?? []).slice(0, 2))
        if (typeof x === "string" && x.trim())
          reqs.push({ style: "follow-up", lang: "en", text: x.trim(), at: tp.followAt! });
    // The lexical leak check flags, it does not drop: in the pilot most flags were amounts and names the user states
    // themself (D882). Whether a request gives the fact away is the critic's question.
    for (const q of reqs) {
      const l = leaks(q.text, `${fact.title}\n${fact.text}`, others, known);
      if (l.length) {
        notes.push({ world: p.id, task: tp.task, leak: l, request: q.text });
        rej["flag: lexical leak (kept)"] = (rej["flag: lexical leak (kept)"] ?? 0) + 1;
      }
    }
    const kept = reqs;
    if (
      kept.filter((q) => q.lang === "en").length < 4 ||
      (tp.timing === "multiday" && !kept.some((q) => q.style === "follow-up"))
    ) {
      bump("task: too few requests");
      continue;
    }
    // A near copy of a train template (word-trigram Jaccard of the imperative and the fact against any train text).
    const probe = shingles(`${kept[0]!.text}\n${fact.title}\n${fact.text}`);
    let best = 0;
    let which = "";
    train.sets.forEach((s, i) => {
      const sim = jaccard(probe, s);
      if (sim > best) ((best = sim), (which = train.names[i]!));
    });
    if (best >= 0.25) {
      notes.push({ world: p.id, task: tp.task, nearTrain: which, sim: best });
      bump("task: near a train template");
      continue;
    }
    items.push(fact, decoy, ...neutrals);
    tasks.push({
      id: tp.task,
      family: f.id,
      area: f.area,
      archetype: f.archetype,
      timing: tp.timing,
      decoyKind: f.decoyKind,
      rare: tp.source in RARE_SOURCES,
      detail: String(raw.detail ?? f.fact).slice(0, 500),
      fact: fact.id,
      decoy: decoy.id,
      neutrals: neutrals.map((x) => x.id),
      requests: kept.map((q, i) => ({ id: `${tp.task}r${i + 1}`, ...q })),
    });
  }
  const sources = Object.fromEntries(
    [...new Set(items.map((i) => i.source))]
      .filter((s) => s in RARE_SOURCES)
      .map((s) => [s, RARE_SOURCES[s]!.description]),
  );
  let world: SynthWorld = {
    v: 1,
    id: p.id,
    split: p.split,
    persona,
    people: w.people
      .filter((x) => x?.full && x.email)
      .slice(0, 40)
      .map((x) => ({
        full: String(x.full),
        email: String(x.email),
        relation: String(x.relation ?? ""),
        ...(x.role ? { role: String(x.role).slice(0, 80) } : {}),
      })),
    sources,
    items,
    tasks,
    gen: { model: "claude-haiku-5-5", usd, calls, seed: 9_100_000 + p.index },
  };
  // Repair, not reject: a background item with a wrong weekday is dropped; a task whose own item or request has one
  // is dropped whole. A world needs six of its eight tasks left.
  for (let round = 0; round < 3; round++) {
    const v = validateWorld(world);
    if (!v.world) {
      bump("world: schema");
      notes.push({ world: p.id, schema: v.problems });
      return undefined;
    }
    if (!v.problems.length) break;
    const badItems = new Set<string>();
    const badTasks = new Set<string>();
    for (const prob of v.problems) {
      const m = /^(i\d+|t\d+(?:r\d+)?):/.exec(prob);
      if (!m) continue;
      if (m[1]!.startsWith("t")) badTasks.add(m[1]!.replace(/r\d+$/, ""));
      else badItems.add(m[1]!);
      bump(`repair: ${prob.replace(/^[it]\d+(r\d+)?: /, "").replace(/ .*$/, "")}`);
    }
    for (const t of world.tasks) if ([t.fact, t.decoy, ...t.neutrals].some((x) => badItems.has(x))) badTasks.add(t.id);
    const drop = new Set(
      world.tasks.filter((t) => badTasks.has(t.id)).flatMap((t) => [t.fact, t.decoy, ...t.neutrals]),
    );
    world = {
      ...world,
      items: world.items.filter((i) => !badItems.has(i.id) && !drop.has(i.id)),
      tasks: world.tasks.filter((t) => !badTasks.has(t.id)),
    };
    if (!badItems.size && !badTasks.size) {
      notes.push({ world: p.id, unrepairable: v.problems });
      bump("world: unrepairable");
      return undefined;
    }
  }
  const final = validateWorld(world);
  if (!final.world || final.problems.length) {
    bump("world: invalid after repair");
    return undefined;
  }
  if (world.tasks.length < 6) {
    bump("world: under six tasks");
    return undefined;
  }
  return world;
}

function assemble() {
  const fams = new Map(readJsonl<Fam>(join(DIR, "families.jsonl")).map((f) => [f.id, f]));
  const corpus: TrainTemplate[] = trainCorpus();
  const train = {
    sets: corpus.flatMap((t) => [t.request, t.fact, t.decoy].map((x) => shingles(x))),
    names: corpus.flatMap((t) => [0, 1, 2].map(() => `${t.suite}/${t.template}`)),
  };
  const rej: Rejects = {};
  const notes: Record<string, unknown>[] = [];
  const out: Record<string, SynthWorld[]> = { train: [], val: [], test: [] };
  const ps = plans();
  let planned = 0;
  for (const p of ps) {
    if (!readResult(DIR, `world/${p.id}`)) continue;
    if (!p.tasks.every((t) => readResult(DIR, `task/${p.id}/${t.task}`))) continue;
    // `--require-revise`: a world is published only once every task has had its revision pass (D883).
    if (args.includes("--require-revise") && !p.tasks.every((t) => readResult(DIR, `revise/${p.id}/${t.task}`)))
      continue;
    planned++;
    const w = assembleWorld(p, fams, train, rej, notes);
    if (w) out[w.split]!.push(w);
  }
  mkdirSync(join(DIR, "worlds"), { recursive: true });
  const suffix = opt("out-suffix", "");
  for (const s of ["train", "val", "test"]) writeJsonl(join(DIR, "worlds", `${s}${suffix}.jsonl`), out[s]!);
  writeJsonl(join(DIR, `assemble-notes${suffix}.jsonl`), notes);
  const all = Object.values(out).flat();
  const pairs = all.reduce(
    (c, w) => {
      const x = countPairs(w);
      for (const k of Object.keys(c) as (keyof typeof c)[]) c[k] += x[k];
      return c;
    },
    { pairs: 0, changes: 0, clear: 0, unrelated: 0, visible: 0 },
  );
  const tasks = all.flatMap((w) => w.tasks);
  const count = (k: (t: SynthTask) => string) =>
    tasks.reduce<Record<string, number>>((m, t) => ((m[k(t)] = (m[k(t)] ?? 0) + 1), m), {});
  const reqs = tasks.flatMap((t) => t.requests);
  const usd = all.reduce((n, w) => n + w.gen.usd, 0);
  const stats = {
    worldsComplete: planned,
    worldsValid: all.length,
    bySplit: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])),
    tasks: tasks.length,
    families: new Set(tasks.map((t) => t.family)).size,
    items: all.reduce((n, w) => n + w.items.length, 0),
    requests: reqs.length,
    pairs,
    timing: count((t) => t.timing),
    rare: count((t) => String(t.rare)),
    area: count((t) => t.area),
    archetype: count((t) => t.archetype),
    decoyKind: count((t) => t.decoyKind),
    styles: reqs.reduce<Record<string, number>>((m, r) => ((m[r.style] = (m[r.style] ?? 0) + 1), m), {}),
    langs: reqs.reduce<Record<string, number>>((m, r) => ((m[r.lang] = (m[r.lang] ?? 0) + 1), m), {}),
    rejects: rej,
    usdGeneration: Number(usd.toFixed(4)),
    usdPerValidWorld: all.length ? Number((usd / all.length).toFixed(5)) : null,
  };
  writeFileSync(join(DIR, `stats${suffix}.json`), JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(stats, null, 2));
}

const cmd = args[0];
if (cmd === "families") await families();
else if (cmd === "plan") plan();
else if (cmd === "worlds") {
  // A reply with no usable world (a refusal, or one that stops after the people) is asked again, twice at most.
  for (const p of plans()) {
    const key = `world/${p.id}`;
    const r = readResult(DIR, key);
    if (!r || (rawWorld(p)?.persona && Array.isArray(rawWorld(p)?.items))) continue;
    const tries = existsSync(join(DIR, "parts", "world"))
      ? readdirSync(join(DIR, "parts", "world")).filter((f) => f.startsWith(`${p.id}.bad`)).length
      : 0;
    if (tries >= 2) continue;
    dropResult(DIR, key);
    // Its tasks were written for the persona being replaced.
    for (const t of p.tasks) dropResult(DIR, `task/${p.id}/${t.task}`);
  }
  await run(worldJobs());
} else if (cmd === "tasks") await run(taskJobs());
else if (cmd === "revise") await run(reviseJobs());
else if (cmd === "assemble") assemble();
else {
  console.log("usage: gen.ts families|plan|worlds|tasks|assemble [flags] (see the header)");
  process.exit(cmd ? 1 : 0);
}
