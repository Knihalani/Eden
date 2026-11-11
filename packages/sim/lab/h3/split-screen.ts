/**
 * H3 (docs/research/h3-pushcheck-lean.md): the push check split into concurrent calls, screened on recorded pools.
 * Re-asks each `--check-dump` row live under every arm, the arms interleaved row by row in the same lanes so load is
 * shared: W (the whole pool, one call, the shipped check), S2 (the pool's two halves, two calls at once) and S3
 * (thirds). Per arm: calls, $ a check, wall a check (a split check's slowest call), and the items named: planted (on
 * hidden rows) and look-alike (the control rows' planted id) named, and agreement with the recorded verdict. Sim data;
 * Anthropic (lab, D97), spend-capped.
 *
 *   bun packages/sim/lab/h3/split-screen.ts --arms W,S2,S3 --out F.jsonl --spend-ledger L --spend-cap 1 DUMP.jsonl
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Budget } from "@eden/llm";
import { PushChecker, type PushCheckInput } from "@eden/engine";
import { labAccess, labModel } from "../../src/lab/free";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1]! : d);
const VALUED = ["--out", "--spend-ledger", "--spend-cap", "--n", "--arms", "--lanes", "--run-label"];
const files = args.filter((a, i) => a.endsWith(".jsonl") && !VALUED.includes(args[i - 1] ?? ""));
const N = Number(opt("n", "100000"));
const OUT = opt("out", "");
const ARMS = opt("arms", "W,S2,S3").split(",");
const LANES = Number(opt("lanes", "4"));
const MODEL = "claude-haiku-5-5";
const access = labAccess(args, [MODEL]);
const model = labModel(access, { apiKey: "", model: MODEL, timeoutMs: 60_000 }, "eden.check");

interface Row {
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
const sample = rows.filter((r) => r.yes !== null).slice(0, N);
if (OUT) writeFileSync(OUT, "");

/** Splits n items into k contiguous parts as even as can be, the first parts the larger. */
const parts = (n: number, k: number) => {
  const out: [number, number][] = [];
  let at = 0;
  for (let p = 0; p < k; p++) {
    const size = Math.floor(n / k) + (p < n % k ? 1 : 0);
    if (size > 0) out.push([at, at + size]);
    at += size;
  }
  return out;
};

const checker = new PushChecker({
  model,
  budget: new Budget({ callsPerSession: 1e9, usdPerSession: 1e9, usdPerUserDay: 1e9 }),
});
const scope = { tenantId: "h3", userId: "split" };
interface Tally {
  checks: number;
  failed: number;
  calls: number;
  usd: number;
  wall: number[];
  planted: number;
  decoy: number;
  same: number;
  named: number;
  neutralSpoke: number;
  neutral: number;
}
const tally = new Map<string, Tally>(
  ARMS.map((a) => [
    a,
    { checks: 0, failed: 0, calls: 0, usd: 0, wall: [], planted: 0, decoy: 0, same: 0, named: 0, neutralSpoke: 0, neutral: 0 },
  ]),
);
await Promise.all(
  Array.from({ length: LANES }, async (_, lane) => {
    for (let k = lane; k < sample.length; k += LANES) {
      const r = sample[k]!;
      const items = r.items.map((it) => ({ ...it, hash: "" }));
      // Rotate the arms' order row by row, so no arm always goes first after a lane's previous row.
      const order = ARMS.map((_, i) => ARMS[(i + k) % ARMS.length]!);
      for (const arm of order) {
        // W: the shipped check; Wk: its first k items; Sk: the pool in k concurrent calls; D: the pool less items
        // whose source and title an earlier item already has; Dk: D's first k.
        const n = arm.startsWith("S") ? Number(arm.slice(1)) : 1;
        const head = /^[WD]\d+$/.test(arm) ? Number(arm.slice(1)) : items.length;
        const seen = new Set<string>();
        const read = (arm.startsWith("D") ? items.filter((it) => {
          const key = `${it.source}\t${it.title.toLowerCase()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }) : items).slice(0, head);
        const t0 = performance.now();
        const reads = await Promise.all(
          parts(read.length, n).map(([a, b]) =>
            checker.check(scope, `s${k}${arm}`, { request: r.request, today: r.today, items: read.slice(a, b) }, new AbortController().signal),
          ),
        );
        const wall = performance.now() - t0;
        const t = tally.get(arm)!;
        t.checks++;
        t.calls += reads.length;
        t.usd += reads.reduce((s, x) => s + x.costUsd, 0);
        t.wall.push(wall);
        if (reads.some((x) => x.yes === null)) {
          t.failed++;
          continue;
        }
        const yes = items.filter((it) => reads.some((x) => x.yes!.has(it.id))).map((it) => it.id).slice(0, 5);
        t.named += yes.length;
        if (r.variant === "hidden" && yes.includes(r.planted)) t.planted++;
        if (r.variant === "control" && yes.includes(r.planted)) t.decoy++;
        if (r.variant === "neutral") {
          t.neutral++;
          if (yes.length) t.neutralSpoke++;
        }
        if ([...yes].sort().join(",") === [...r.yes!].slice(0, 5).sort().join(",")) t.same++;
        if (OUT) appendFileSync(OUT, `${JSON.stringify({ k, arm, variant: r.variant, recorded: r.yes, yes, wall, usd: reads.reduce((s, x) => s + x.costUsd, 0) })}\n`);
      }
    }
  }),
);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
const hidden = sample.filter((r) => r.variant === "hidden").length;
const control = sample.filter((r) => r.variant === "control").length;
console.log(`rows ${sample.length} (hidden ${hidden}, control ${control})`);
for (const [arm, t] of tally)
  console.log(
    `${arm.padEnd(3)} checks ${t.checks} failed ${t.failed} calls ${t.calls} $/check ${(t.usd / t.checks).toFixed(6)} ` +
      `wall p50 ${(pct(t.wall, 0.5) / 1000).toFixed(2)} p90 ${(pct(t.wall, 0.9) / 1000).toFixed(2)} s; ` +
      `planted named ${t.planted}, look-alike named ${t.decoy}, neutral spoke ${t.neutralSpoke}/${t.neutral}, ` +
      `items named ${t.named}, same as recorded ${t.same}`,
  );
