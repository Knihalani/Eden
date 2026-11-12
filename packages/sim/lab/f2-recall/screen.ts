/**
 * F2 (docs/research/f2-push-recall.md): the push check's instructions, screened on recorded pools. Re-asks every
 * `--check-dump` row live under each arm's instructions (the shipped user turn, the shipped parser), the arms
 * interleaved row by row in the same lanes. Per arm, per task (the union of a task's checks): planted named on
 * hidden tasks, the look-alike named on control tasks, neutral tasks with any item named, items named, $ a check.
 * Sim data; Anthropic (lab, D97), spend-capped. Train, reworded and longtail dumps only (never a held-out suite).
 *
 *   bun packages/sim/lab/f2-recall/screen.ts --arms W,A,R --out F.jsonl --spend-ledger L --spend-cap 40 DUMP.jsonl…
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { CHECK_SYSTEM, checkMessages, parseCompare, type PushCheckInput } from "@eden/engine";

/** The shipped output cap (`COMPARE_MAX_TOKENS` in push-check.ts). */
const COMPARE_MAX_TOKENS = 500;
import { labAccess, labModel } from "../../src/lab/free";
import { ARM_SYSTEMS } from "./arms";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1]! : d);
const VALUED = ["--out", "--spend-ledger", "--spend-cap", "--arms", "--lanes", "--run-label", "--every"];
const files = args.filter((a, i) => a.endsWith(".jsonl") && !VALUED.includes(args[i - 1] ?? ""));
const OUT = opt("out", "");
const ARMS = opt("arms", "W,A").split(",");
const LANES = Number(opt("lanes", "8"));
// `--every k`: every k-th row (a cheaper screen that keeps every suite and variant).
const EVERY = Number(opt("every", "1"));
const MODEL = "claude-haiku-5-5";
const access = labAccess(args, [MODEL]);
const model = labModel(access, { apiKey: "", model: MODEL, timeoutMs: 60_000 }, "eden.check");
// W2 is the shipped check asked again: the noise floor any arm is read against (Haiku repeats 75–79% of item
// sets, D931).
const systems: Record<string, string> = { W: CHECK_SYSTEM, W2: CHECK_SYSTEM, ...ARM_SYSTEMS };
for (const a of ARMS) if (!systems[a]) throw new Error(`no arm ${a}`);

interface Row {
  suite: string;
  seed: number;
  template: string;
  request: string;
  today: string;
  items: Omit<PushCheckInput["items"][number], "hash">[];
  yes: string[] | null;
  variant: string;
  planted: string;
}
const rows: Row[] = [];
for (const f of files)
  for (const l of readFileSync(f, "utf8").split("\n")) if (l.trim()) rows.push(JSON.parse(l) as Row);
const sample = rows.filter((r, i) => r.yes !== null && i % EVERY === 0);
if (OUT) writeFileSync(OUT, "");

interface Tally {
  checks: number;
  failed: number;
  usd: number;
  named: Map<string, Set<string>>;
}
const tally = new Map<string, Tally>(ARMS.map((a) => [a, { checks: 0, failed: 0, usd: 0, named: new Map() }]));
let failedInRow = 0;
const taskOf = (r: Row) => `${r.suite}\t${r.seed}\t${r.template}\t${r.variant}`;
await Promise.all(
  Array.from({ length: LANES }, async (_, lane) => {
    for (let k = lane; k < sample.length; k += LANES) {
      const r = sample[k]!;
      const input = { request: r.request, today: r.today, items: r.items.map((it) => ({ ...it, hash: "" })) };
      const order = ARMS.map((_, i) => ARMS[(i + k) % ARMS.length]!);
      for (const arm of order) {
        const t = tally.get(arm)!;
        const messages = checkMessages(input);
        messages[0] = { role: "system", content: systems[arm]! };
        let yes: string[] | null = null;
        let usd = 0;
        try {
          const res = await model.chat({ messages, maxTokens: COMPARE_MAX_TOKENS, json: true });
          usd = res.costUsd;
          const at = res.truncated ? null : parseCompare(res.text, input.items.length);
          yes = at ? at.map((i) => input.items[i]!.id) : null;
        } catch (err) {
          yes = null;
          // A refused account (HTTP 400: no credit, a bad key) fails every call: stop rather than count them as checks.
          if (++failedInRow >= 20) {
            console.error(`screen: 20 calls in a row failed; stopping (${String(err).slice(0, 200)})`);
            process.exit(1);
          }
        }
        if (yes !== null) failedInRow = 0;
        t.checks++;
        t.usd += usd;
        const task = taskOf(r);
        if (!t.named.has(task)) t.named.set(task, new Set());
        // A failed check fails open in the engine (the default's candidates); here it names nothing new.
        if (yes === null) t.failed++;
        else for (const id of yes) t.named.get(task)!.add(id);
        if (OUT)
          appendFileSync(OUT, `${JSON.stringify({ k, arm, task, planted: r.planted, recorded: r.yes, yes, usd })}\n`);
      }
    }
  }),
);
const planted = new Map(sample.map((r) => [taskOf(r), r.planted]));
for (const [arm, t] of tally) {
  let hidden = 0,
    control = 0,
    neutral = 0,
    p = 0,
    d = 0,
    n = 0,
    items = 0;
  for (const [task, named] of t.named) {
    const v = task.split("\t")[3];
    items += named.size;
    if (v === "hidden") (hidden++, named.has(planted.get(task)!) && p++);
    if (v === "control") (control++, named.has(planted.get(task)!) && d++);
    if (v === "neutral") (neutral++, named.size > 0 && n++);
  }
  console.log(
    `${arm.padEnd(3)} checks ${t.checks} failed ${t.failed} $/check ${(t.usd / t.checks).toFixed(6)}; ` +
      `planted ${p}/${hidden}, look-alike ${d}/${control}, neutral spoke ${n}/${neutral}, items ${items}`,
  );
}
