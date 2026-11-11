/**
 * M7 (D930): the check's agreement with itself. Re-asks a sample of recorded check calls (`--prescreen-dump` rows)
 * live with the same prompt (`checkMessages`), and compares the verdict (the set of items named) with the recorded
 * one: the noise floor under any pre-screen's disagreement. Sim data; Anthropic (lab, D97), spend-capped.
 *
 *   bun packages/sim/lab/m7/self-agree.ts --n 300 --out F.jsonl --spend-ledger L --spend-cap 0.2 DUMP.jsonl ...
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Budget } from "@eden/llm";
import { PushChecker, type PushCheckInput } from "@eden/engine";
import { labAccess, labModel } from "../../src/lab/free";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1]! : d);
const VALUED = ["--out", "--spend-ledger", "--spend-cap", "--n"];
const files = args.filter((a, i) => a.endsWith(".jsonl") && !VALUED.includes(args[i - 1] ?? ""));
const N = Number(opt("n", "300"));
const OUT = opt("out", "");
const MODEL = "claude-haiku-5-5";
const access = labAccess(args, [MODEL]);
const model = labModel(access, { apiKey: "", model: MODEL, timeoutMs: 60_000 }, "eden.check");

interface Row {
  request: string;
  today: string;
  items: Omit<PushCheckInput["items"][number], "hash">[];
  yes: string[] | null;
  variant: string;
}
const rows: Row[] = [];
for (const f of files)
  for (const l of readFileSync(f, "utf8").split("\n")) if (l.trim()) rows.push(JSON.parse(l) as Row);
// A fixed shuffle (an LCG), so the sample is the same on every run.
let s = 7;
const pick = rows.filter((r) => r.yes !== null);
for (let i = pick.length - 1; i > 0; i--) {
  s = (s * 1103515245 + 12345) % 2147483648;
  const j = s % (i + 1);
  [pick[i], pick[j]] = [pick[j]!, pick[i]!];
}
if (OUT) writeFileSync(OUT, "");
let same = 0;
let silentSame = 0;
let silentN = 0;
let done = 0;
const checker = new PushChecker({
  model,
  budget: new Budget({ callsPerSession: 1e9, usdPerSession: 1e9, usdPerUserDay: 1e9 }),
});
const sample = pick.slice(0, N);
const scope = { tenantId: "m7", userId: "agree" };
await Promise.all(
  Array.from({ length: 6 }, async (_, lane) => {
    for (let k = lane; k < sample.length; k += 6) {
      const r = sample[k]!;
      const items = r.items.map((it) => ({ ...it, hash: "" }));
      const input = { request: r.request, today: r.today, items };
      const read = await checker.check(scope, `s${k}`, input, new AbortController().signal);
      if (!read.yes) continue;
      done++;
      const a = [...r.yes!].sort().join(",");
      const b = [...read.yes].sort().join(",");
      if (a === b) same++;
      if (r.yes!.length === 0) {
        silentN++;
        if (read.yes.size === 0) silentSame++;
      }
      if (OUT)
        appendFileSync(OUT, `${JSON.stringify({ k, variant: r.variant, recorded: r.yes, again: [...read.yes] })}\n`);
    }
  }),
);
console.log(
  `re-asked ${done}: verdict identical ${same} (${((100 * same) / done).toFixed(1)}%); recorded silent ${silentN}, ` +
    `silent again ${silentSame} (${((100 * silentSame) / Math.max(1, silentN)).toFixed(1)}%); ` +
    `$${checker.stats.costUsd.toFixed(4)}`,
);
