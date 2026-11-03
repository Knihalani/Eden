/**
 * The distilled reader (lab only; docs/research/distilled-reader.md): a no-model scorer for the ask-time reader's
 * relational verdict ("does this candidate bind this request?", D95/D96), used as a cascade. The scorer reads the same
 * `ReaderInput` the model would (the request, the day, and each candidate's title, text, date, sender and card line)
 * and scores every candidate; a call whose pool it is confident about is answered locally, and only the rest go to the
 * real reader. It sits behind `ReaderMaker`, so the engine builds, gates and caches the reader's pool exactly as with a
 * model, and nothing in `packages/engine` changes.
 *
 * Three uses, one class (`DistilledReaderMaker`):
 * - `record` calls the real reader on every read and appends (task, planted item, input, verdict) to a JSONL file, so
 *   the reader's verdicts become labels for (request, candidate) pairs;
 * - `labels` answers every read from a committed labels file (keyed by task and `readerKey`) and records each call as
 *   `record` does (to `labels:LABELS,OUT`'s OUT), a $0 replay that rebuilds the records without committing item text;
 * - `cascade` scores the pool and decides confident calls locally (`decide`), escalating the rest to the inner reader.
 *
 * Every text field read here was already redacted and bounded by `readerItem`; the scorer only counts words.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { ACTIONS, CARD_KINDS, readerKey, type ReaderInput, type ReaderKind, type ReaderMaker } from "@eden/engine";

type MakerResult = Awaited<ReturnType<ReaderMaker["read"]>>;

const STOP = new Set(
  (
    "the and for with from that this have has had are was were will would can could should into onto about your you " +
    "our out off any all not but its it's them they their there then than what when where which who whom why how " +
    "please just also more some such very can't don't let let's me my mine we us his her him she he to of in on at " +
    "by or an a is be as do if so up no it i get go make need want next new today tomorrow week"
  ).split(" "),
);

const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w));
/** A crude stem, so "booking" meets "book" and "payments" meets "pay": the first five letters of a word. */
const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w);
const count = (re: RegExp, text: string) => (text.match(re) ?? []).length;

/** Words saying a constraint was lifted, met or no longer holds: what most decoys say (broad-set.md). */
const RESOLVED =
  /\b(?:lift\w*|resolv\w*|restor\w*|cancel\w*|no longer|reopen\w*|back on|sorted|fixed|already|done|paid|approv\w*|signed|complet\w*|confirmed|cleared|ended|over now|withdrawn|reinstat\w*|unfrozen|unblock\w*|resum\w*)\b/gi;
/** Words that state a constraint in force. */
const CONSTRAINT =
  /\b(?:until|must|only|hold|frozen|freez\w*|block\w*|suspend\w*|pause\w*|not|don't|do not|never|allerg\w*|limit\w*|cap|max\w*|deadline|due|away|leave|unavailable|requir\w*|needs?|before|policy|wait|expir\w*|moved?|instead)\b/gi;
const MONEY = /[£$€]\s?\d|\d\s?%/;

/** The card line's fields (`cardLine`: "kind=…; actions=…; about=…; from=…; until=…; limit=…; says=…"). */
function cardFields(card: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!card) return out;
  for (const part of card.split("; ")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** Each action's description, as stems: a request meets a card's action on a word neither has to share. */
const ACTION_STEMS = new Map(
  Object.entries(ACTIONS).map(([a, d]) => [a, new Set([...words(d), ...words(a)].map(stem))] as const),
);
const KINDS = CARD_KINDS.filter((k) => k !== "none");
const SOURCES = ["mail", "cal", "doc", "crm", "chat"];

/** Days from the day to a YYYY-MM-DD(...) date; NaN when there is none. */
const days = (date: string | undefined, today: string) =>
  date && /^\d{4}-\d{2}-\d{2}/.test(date)
    ? (Date.parse(date.slice(0, 10)) - Date.parse(today.slice(0, 10))) / 86_400_000
    : NaN;

export const FEATURE_NAMES = [
  "pos",
  "logPool",
  "hasCard",
  ...KINDS.map((k) => `kind:${k}`),
  "cardActionMeets",
  "cardAboutOverlap",
  "cardAboutName",
  "untilPast",
  "untilAhead",
  "fromAhead",
  "cardLimit",
  "titleOverlap",
  "textOverlap",
  "overlapN",
  "overlapTop",
  "overlapGap",
  "nameOverlap",
  "resolved",
  "constraint",
  "money",
  "ageDays",
  "dateAhead",
  ...SOURCES.map((s) => `src:${s}`),
  "hasFrom",
  "requestWords",
] as const;

/** The features of every candidate in a pool, in order: one row per item, `FEATURE_NAMES` long. */
export function poolFeatures(input: ReaderInput): number[][] {
  const req = input.request + (input.question ? ` ${input.question}` : "");
  const rw = new Set(words(req).map(stem));
  // Capitalised words of the request that are not its first: names of people, places and things.
  const names = new Set(
    (req.match(/(?<=\s)\p{Lu}[\p{L}'-]+/gu) ?? []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)),
  );
  const n = input.items.length;
  const overlaps = input.items.map((it) => {
    const s = new Set(words(`${it.title} ${it.text}`).map(stem));
    let k = 0;
    for (const w of rw) if (s.has(w)) k++;
    return k;
  });
  const top = Math.max(0, ...overlaps);
  return input.items.map((it, i) => {
    const c = cardFields(it.card);
    const about = c.about ?? "";
    const aboutStems = new Set(words(about).map(stem));
    const acts = (c.actions ?? "").split(",").filter(Boolean);
    const titleStems = new Set(words(it.title).map(stem));
    const body = `${it.title} ${it.text}`;
    const lower = body.toLowerCase();
    const frac = (s: Set<string>) => {
      let k = 0;
      for (const w of rw) if (s.has(w)) k++;
      return rw.size ? k / rw.size : 0;
    };
    let nameHits = 0;
    for (const nm of names) if (lower.includes(nm)) nameHits++;
    let aboutNames = 0;
    for (const nm of names) if (about.toLowerCase().includes(nm)) aboutNames++;
    const until = days(c.until, input.today);
    const from = days(c.from, input.today);
    const age = days(it.date, input.today);
    const src = it.source.toLowerCase();
    return [
      n > 1 ? i / (n - 1) : 0,
      Math.log1p(n),
      it.card ? 1 : 0,
      ...KINDS.map((k) => (c.kind === k ? 1 : 0)),
      acts.some((a) => [...(ACTION_STEMS.get(a) ?? [])].some((w) => rw.has(w))) ? 1 : 0,
      Math.min(3, [...rw].filter((w) => aboutStems.has(w)).length) / 3,
      Math.min(2, aboutNames) / 2,
      until < 0 ? 1 : 0,
      until >= 0 ? 1 : 0,
      from > 0 ? 1 : 0,
      c.limit !== undefined ? 1 : 0,
      frac(titleStems),
      frac(new Set(words(it.text).map(stem))),
      Math.min(5, overlaps[i]!) / 5,
      overlaps[i] === top && top > 0 ? 1 : 0,
      (top - overlaps[i]!) / 5,
      Math.min(2, nameHits) / 2,
      Math.min(3, count(RESOLVED, body)) / 3,
      Math.min(5, count(CONSTRAINT, body)) / 5,
      MONEY.test(body) ? 1 : 0,
      Number.isNaN(age) ? 0 : Math.max(-3, Math.min(3, age / 30)),
      age > 0 ? 1 : 0,
      ...SOURCES.map((s) => (src.includes(s) ? 1 : 0)),
      it.from ? 1 : 0,
      Math.min(30, rw.size) / 30,
    ];
  });
}

/** One regression tree: internal nodes split a feature at a threshold, leaves hold a log-odds step. */
export type Tree = { f: number; t: number; l: Tree; r: Tree } | { v: number };

/** The scorer: boosted trees over `poolFeatures`, and the two thresholds a call is decided at. */
export interface DistilledModel {
  version: 1;
  features: readonly string[];
  base: number;
  trees: Tree[];
  /** A call whose best candidate scores below `silent` is answered locally: nothing binds. */
  silent: number;
  /**
   * A candidate at or above `bind` is flagged locally when it is the only one above `silent`; Infinity turns it off.
   * Serialised as null.
   */
  bind: number | null;
  /** Per fold (a held-out train suite): a model fitted without it, for cross-validated screens. */
  folds?: Record<string, Omit<DistilledModel, "folds">>;
}

const leaf = (t: Tree, x: number[]): number => ("v" in t ? t.v : leaf(x[t.f]! <= t.t ? t.l : t.r, x));

/** The probability that each candidate binds, as the scorer reads it. */
export function scorePool(model: Omit<DistilledModel, "folds">, input: ReaderInput): number[] {
  return poolFeatures(input).map((x) => {
    let z = model.base;
    for (const t of model.trees) z += leaf(t, x);
    return 1 / (1 + Math.exp(-z));
  });
}

/** A local verdict, or null: the call goes to the reader. */
export function decide(model: Omit<DistilledModel, "folds">, scores: number[]): MakerResult | null {
  const max = Math.max(0, ...scores);
  if (max < model.silent) return { bears: [], rejected: [], costUsd: 0 };
  const above = scores.filter((s) => s >= model.silent).length;
  if (model.bind !== null && max >= model.bind && above === 1) {
    const i = scores.indexOf(max);
    // The kind is the mildest that still leads (`parseReaderFull`'s fallback): the scorer cannot say which.
    return { bears: [{ i, kind: "changes" as ReaderKind, why: "" }], rejected: [], costUsd: 0 };
  }
  return null;
}

/** One reader call as recorded: what was asked, and what the reader answered (null: no readable answer). */
export interface RecordedCall {
  task: string;
  planted: { id: string; role: "hidden" | "decoy" };
  key: string;
  today: string;
  request: string;
  question?: string;
  items: ReaderInput["items"];
  bears: { i: number; kind: ReaderKind }[] | null;
  rejected: number[];
}

/**
 * One committed label row: the call's task and `readerKey`, its pool size, the planted item (and its index in the pool,
 * -1 when absent) and the reader's verdict by index. No item text: `labels` mode rebuilds the records from the worlds.
 */
export interface LabelRow {
  task: string;
  key: string;
  n: number;
  planted: { id: string; role: "hidden" | "decoy"; at: number };
  bears: { i: number; kind: ReaderKind }[] | null;
  rejected: number[];
}

export type DistillMode = "record" | "labels" | "cascade";

/** What a cascade did: calls decided locally (silent or bind) and escalated, per suite. */
export interface CascadeStats {
  silent: number;
  bind: number;
  escalated: number;
  bySuite: Record<string, { silent: number; bind: number; escalated: number }>;
}

/**
 * The reader as the experiment uses it. `task` and `planted` are set by the harness before each task, as for the
 * oracle (`reader-stub.ts`).
 */
export class DistilledReaderMaker implements ReaderMaker {
  task = "";
  planted: { id: string; role: "hidden" | "decoy" } = { id: "", role: "hidden" };
  readonly stats: CascadeStats = { silent: 0, bind: 0, escalated: 0, bySuite: {} };
  private labels = new Map<string, LabelRow>();
  /** `labels` reads that found no row: a rerun on a changed engine (the pool moved). */
  missed = 0;

  constructor(
    readonly mode: DistillMode,
    private readonly inner: ReaderMaker | null,
    private readonly file: string,
    private readonly model: DistilledModel | null = null,
    /** Where `labels` records its calls. */
    private readonly out = "",
  ) {
    if (mode === "labels") {
      if (!out) throw new Error("--distill labels needs an output file: labels:LABELS.jsonl,OUT.jsonl");
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as LabelRow;
        this.labels.set(`${row.task}\n${row.key}`, row);
      }
    }
    if (mode === "cascade" && !model) throw new Error("--distill cascade needs a model file");
    if ((mode === "record" || mode === "cascade") && !inner) throw new Error(`--distill ${mode} needs a reader model`);
  }

  /** The model for this task: the fold that left its suite out when the file has one (cross-validated screens). */
  private modelFor(): Omit<DistilledModel, "folds"> {
    const suite = this.task.split("/")[0]!;
    return this.model!.folds?.[suite] ?? this.model!;
  }

  async read(input: ReaderInput, signal: AbortSignal): Promise<MakerResult> {
    const key = readerKey(input);
    if (this.mode === "labels") {
      const row = this.labels.get(`${this.task}\n${key}`);
      if (!row) {
        this.missed++;
        return { bears: null, rejected: [], costUsd: 0 };
      }
      this.append(input, key, row.bears, row.rejected);
      return { bears: row.bears?.map((b) => ({ ...b, why: "" })) ?? null, rejected: row.rejected, costUsd: 0 };
    }
    if (this.mode === "cascade") {
      const suite = this.task.split("/")[0]!;
      const s = (this.stats.bySuite[suite] ??= { silent: 0, bind: 0, escalated: 0 });
      const local = decide(this.modelFor(), scorePool(this.modelFor(), input));
      if (local) {
        const which = local.bears!.length ? "bind" : "silent";
        this.stats[which]++;
        s[which]++;
        return local;
      }
      this.stats.escalated++;
      s.escalated++;
      return this.inner!.read(input, signal);
    }
    const got = await this.inner!.read(input, signal);
    this.append(input, key, got.bears?.map(({ i, kind }) => ({ i, kind })) ?? null, got.rejected ?? []);
    return got;
  }

  private append(input: ReaderInput, key: string, bears: RecordedCall["bears"], rejected: number[]): void {
    const call: RecordedCall = {
      task: this.task,
      planted: this.planted,
      key,
      today: input.today,
      request: input.request,
      ...(input.question ? { question: input.question } : {}),
      items: input.items,
      bears,
      rejected,
    };
    appendFileSync(this.mode === "labels" ? this.out : this.file, `${JSON.stringify(call)}\n`);
  }
}

/** `--distill MODE:FILE`: `record:OUT.jsonl`, `labels:LABELS.jsonl,OUT.jsonl` or `cascade:MODEL.json`. */
export function parseDistill(spec: string): { mode: DistillMode; file: string; out: string } {
  const m = /^(record|labels|cascade):([^,]+)(?:,(.+))?$/.exec(spec);
  if (!m || (m[1] === "labels") !== (m[3] !== undefined)) {
    throw new Error("--distill must be record:FILE, labels:LABELS.jsonl,OUT.jsonl or cascade:MODEL.json");
  }
  return { mode: m[1] as DistillMode, file: m[2]!, out: m[3] ?? "" };
}

/** Reads a model file (`distilled-fit.ts`'s output); `bind: null` means off. */
export function loadModel(file: string): DistilledModel {
  return JSON.parse(readFileSync(file, "utf8")) as DistilledModel;
}
