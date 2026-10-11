/**
 * The `extraction` arm (A5 §4; D7, D9, D37; R8 E3): the 330 hand-annotated phrasings of `extraction-e3.json`, scored
 * by R8's rules (`memory-cues/nim/e3_score.py`, ported):
 * - a false durable is a plain item (request, trap, status, paste: 217) that yields any record; gate ≤ 1%;
 * - a slot hit is an exact (slot, op, value) match with one of the gold alternatives; batch-B recall ≥ 0.70;
 * - a rule hit is a (class, polarity) match; batch-B recall ≥ 0.80.
 * A5's clause on an admitted sleep model (D37) needs an opted-in model and is not run here.
 *
 * Extraction is inside Eden. The arm asks it through an entry point it defines:
 *
 *   eden memory extract --jsonl -   (stdin: {"id", "text"} per line)   →   {"id", "records": [record…]} per line
 *   record: {"kind": "slot", "slot", "op": "set"|"invalidate", "value"}
 *         | {"kind": "policy"|"intent", "class", "polarity": "neg"|"pos", "object", "qualifier"?}
 *
 * P2.1 built the entry point (`packages/cli/src/memory-extract.ts`), with each text's pasted spans stripped first
 * (D12), and confirmed this contract: it answers policy and intent records, D9's. Slot records (D7's slot table) are
 * P3.3's, which owns `slot-recall-b` (ROADMAP).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { monorepo } from "./fixtures/world";
import { check, type Arm, type Check } from "./kit";

const FIXTURE = join(import.meta.dir, "../../memory-cues/fixture/extraction-e3.json");
const PLAIN = new Set(["request", "trap", "status", "paste"]);
/** e3_regex.py `NORM`. */
const NORM: Record<string, string> = {
  postgresql: "postgres",
  nextjs: "next.js",
  next: "next.js",
  mongo: "mongodb",
  "next-auth": "nextauth",
  fly: "fly.io",
  kubernetes: "k8s",
};

export interface E3Item {
  batch: "A" | "B";
  i: number;
  text: string;
  cat: string;
  annotations: string[];
}

export type ExtractRecord =
  | { kind: "slot"; slot: string; op: "set" | "invalidate"; value: string }
  | { kind: "policy" | "intent"; class: string; polarity: string; object?: string; qualifier?: string };

type GoldSlot = { slot: string; op: "set" | "invalidate"; value: string }[];
type GoldRule = { classes: string[]; polarity: string };

export const e3Items = (): E3Item[] => JSON.parse(readFileSync(FIXTURE, "utf8")) as E3Item[];

/** e3_regex.py `norm_value`. */
export function normValue(value: string): string {
  const v = value
    .trim()
    .replace(/^[.,;:!?'"`]+|[.,;:!?'"`]+$/g, "")
    .toLowerCase()
    .replace(/^v(?=\d)/, "");
  return NORM[v] ?? v;
}

/** e3_score.py `parse_gold`: slot alternatives, and rules as (classes, polarity). */
export function parseGold(annotations: readonly string[]): { slots: GoldSlot[]; rules: GoldRule[] } {
  const slots: GoldSlot[] = [];
  const rules: GoldRule[] = [];
  for (const annotation of annotations) {
    const parts = annotation.split(/\s+/);
    if (parts[0] === "slot") {
      const pieces = parts[1]!.split("|");
      const alternatives = (pieces.at(-1)!.includes("=") ? pieces : [parts[1]!]).map((alt) => {
        const invalidate = alt.includes("!=");
        const [slot, value] = alt.split(invalidate ? "!=" : "=") as [string, string];
        return { slot, op: invalidate ? ("invalidate" as const) : ("set" as const), value: normValue(value) };
      });
      if (parts.length > 2) alternatives[0]!.value = normValue(`${alternatives[0]!.value} ${parts.slice(2).join(" ")}`);
      slots.push(parts.length > 2 ? [alternatives[0]!] : alternatives);
    } else {
      rules.push({ classes: parts[1]!.split("|"), polarity: parts[2]! });
    }
  }
  return { slots, rules };
}

export interface E3Score {
  falseDurable: { k: number; n: number };
  slotRecallB: { k: number; n: number };
  ruleRecallB: { k: number; n: number };
}

/** Scores records per item (by id = index in the fixture) as R8 did. */
export function scoreE3(items: readonly E3Item[], records: ReadonlyMap<number, readonly ExtractRecord[]>): E3Score {
  const out: E3Score = { falseDurable: { k: 0, n: 0 }, slotRecallB: { k: 0, n: 0 }, ruleRecallB: { k: 0, n: 0 } };
  items.forEach((item, at) => {
    const found = records.get(at) ?? [];
    if (PLAIN.has(item.cat)) {
      out.falseDurable.n++;
      if (found.length) out.falseDurable.k++;
    }
    if (item.batch !== "B") return;
    const gold = parseGold(item.annotations);
    const slots = found.filter((r): r is Extract<ExtractRecord, { kind: "slot" }> => r.kind === "slot");
    const rules = found.filter((r): r is Extract<ExtractRecord, { kind: "policy" | "intent" }> => r.kind !== "slot");
    const usedSlots = new Set<number>();
    for (const record of slots) {
      const value = normValue(record.value);
      const hit = gold.slots.findIndex(
        (alts, i) =>
          !usedSlots.has(i) &&
          alts.some((alt) => alt.slot === record.slot && alt.op === record.op && alt.value === value),
      );
      if (hit >= 0) usedSlots.add(hit);
    }
    const usedRules = new Set<number>();
    for (const record of rules) {
      const polarity = record.polarity.toLowerCase().slice(0, 3);
      const hit = gold.rules.findIndex(
        (g, i) => !usedRules.has(i) && g.classes.includes(record.class) && g.polarity === polarity,
      );
      if (hit >= 0) usedRules.add(hit);
    }
    out.slotRecallB.n += gold.slots.length;
    out.slotRecallB.k += usedSlots.size;
    out.ruleRecallB.n += gold.rules.length;
    out.ruleRecallB.k += usedRules.size;
  });
  return out;
}

/** The checks of a score (A5 gates). */
export function e3Checks(score: E3Score): Check[] {
  const rate = (r: { k: number; n: number }) => (r.n ? r.k / r.n : 0);
  const show = (r: { k: number; n: number }) => `${r.k}/${r.n} (${(rate(r) * 100).toFixed(1)}%)`;
  return [
    check("false-durable", rate(score.falseDurable) <= 0.01, `false durables ${show(score.falseDurable)}; gate ≤ 1%`),
    check(
      "slot-recall-b",
      rate(score.slotRecallB) >= 0.7,
      `batch-B slot recall ${show(score.slotRecallB)}; gate ≥ 0.70`,
    ),
    check(
      "rule-recall-b",
      rate(score.ruleRecallB) >= 0.8,
      `batch-B rule recall ${show(score.ruleRecallB)}; gate ≥ 0.80`,
    ),
  ];
}

/** The entry point's answer, by item id, when every line is in the contract's shape. */
export function readExtraction(stdout: string, count: number): Map<number, ExtractRecord[]> | undefined {
  const out = new Map<number, ExtractRecord[]>();
  for (const line of stdout.split("\n").filter(Boolean)) {
    try {
      const row = JSON.parse(line) as { id?: unknown; records?: unknown };
      if (typeof row.id !== "number" || !Array.isArray(row.records)) return undefined;
      out.set(row.id, row.records as ExtractRecord[]);
    } catch {
      return undefined;
    }
  }
  return out.size === count ? out : undefined;
}

export const extraction: Arm = {
  id: "extraction",
  flagged: false,
  async run(run) {
    const items = e3Items();
    const world = run.world(monorepo());
    const input = items.map((item, at) => JSON.stringify({ id: at, text: item.text })).join("\n") + "\n";
    const records = readExtraction(
      run.cli(world, ["memory", "extract", "--jsonl", "-"], { input }).stdout,
      items.length,
    );
    if (!records) {
      const missing = "`eden memory extract --jsonl -` gave no records in the contract's shape";
      return [
        check("extracted", false, missing),
        ...["false-durable", "rule-recall-b", "slot-recall-b"].map((id) => check(id, false, missing)),
      ];
    }
    return [check("extracted", true, `${records.size} items answered`), ...e3Checks(scoreE3(items, records))];
  },
};
