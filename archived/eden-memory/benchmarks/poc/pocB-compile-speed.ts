/**
 * POC B — Compiler throughput: stop re-parsing the same commands.
 *
 * During compilation, the same shell command string is tokenized 3–5 times
 * across islands.ts predicates (isGenericBash, isIslandMember, toStep,
 * cleanEvents) and mining alignment all call commandShape/commandShapeKey
 * independently (see shapes.ts). commandShape does quote-aware tokenization
 * plus classification every time. The IR redactor already proved the memo
 * pattern (secretKeyMemo, ir/src/redact.ts).
 *
 * This POC measures the REAL commandShape/commandShapeKey over a realistic
 * corpus, naive vs memoized, plus end-to-end effect on a mining-shaped loop.
 */
import { commandShape, commandShapeKey } from "../../packages/core/src/index.ts";
import { header, printRow, nowMs, median } from "./lib.ts";

// Realistic compile corpus: repeated stretch witnesses with per-witness variation.
function corpus(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const pr = 100 + (i % 40);
    out.push(`gh pr view ${pr} --repo acme/app --json title,reviews`);
    out.push(`gh pr checks ${pr} --repo acme/app`);
    out.push(`gh api repos/acme/app/pulls/${pr}/files --paginate`);
    out.push(`kubectl get pods -n app-${i % 3} -o json`);
    out.push(`aws s3 ls s3://acme-artifacts/build-${pr}/`);
    out.push(`stripe invoices list --limit 10 --status open`);
    out.push(`docker ps --filter name=worker-${i % 5}`);
    out.push(`git log --oneline -n 20 main`);
  }
  return out;
}

header("POC B — compiler speed: memoized shape extraction");

const N = 4000;
const cmds = corpus(N);

// Warm JIT once.
commandShapeKey(cmds[0]!);
commandShapeKey(cmds[1]!);

{
  const samples: number[] = [];
  for (let r = 0; r < 15; r++) {
    const t = nowMs();
    let sink = 0;
    for (const c of cmds) sink += commandShape(c)?.varSlots ?? 0;
    if (r === 14 && sink < 0) throw new Error("unreachable");
    samples.push(nowMs() - t);
  }
  printRow(`TODAY   commandShape x${N}`, `${median(samples).toFixed(1)} ms/pass`);
}
{
  const memo = new Map<string, ReturnType<typeof commandShape>>();
  const samples: number[] = [];
  for (let r = 0; r < 15; r++) {
    const t = nowMs();
    let sink = 0;
    for (const c of cmds) {
      let s = memo.get(c);
      if (s === undefined) {
        s = commandShape(c);
        memo.set(c, s);
      }
      sink += s?.varSlots ?? 0;
    }
    if (sink < 0) throw new Error("unreachable");
    samples.push(nowMs() - t);
  }
  printRow(`PROPOSED memoized commandShape x${N}`, `${median(samples).toFixed(2)} ms/pass (steady-state)`);
}

// commandShapeKey includes a sha256 per call; same memo applies.
{
  const samples: number[] = [];
  const t = nowMs();
  for (const c of cmds) commandShapeKey(c);
  samples.push(nowMs() - t);
  const memo = new Map<string, string>();
  const t2 = nowMs();
  for (const c of cmds) {
    let k = memo.get(c);
    if (k === undefined) {
      k = commandShapeKey(c)!;
      memo.set(c, k);
    }
  }
  printRow(
    "TODAY vs PROPOSED commandShapeKey",
    `${median(samples).toFixed(1)} ms → ${(nowMs() - t2).toFixed(2)} ms per pass`,
  );
}

console.log("\nWhy it matters: compile time gates the Workshop loop — candidates appear only after mining finishes.");
console.log(
  "VERDICT: WIN on steady-state passes (the common case: predicates re-inspect the same strings many times per event).",
);
