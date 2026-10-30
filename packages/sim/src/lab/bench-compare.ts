#!/usr/bin/env bun
/**
 * Compares benchmark runs in the ledger (bench/README.md).
 *
 *   bun packages/sim/src/lab/bench-compare.ts --latest baseline probes [--metrics recall,precision]
 *   bun packages/sim/src/lab/bench-compare.ts <id-a> <id-b>
 *   bun packages/sim/src/lab/bench-compare.ts --list [--tier sim]
 *
 * `--latest A B` pairs the newest run labelled A with the newest labelled B for every tier and suite both have, and
 * prints each shared metric with its change. Metric names can be filtered by substring (`--metrics`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR, type LedgerEntry } from "./ledger";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const ledger = readFileSync(join(BENCH_DIR, "ledger.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as LedgerEntry);
const filter = opt("metrics")?.split(",");

if (args.includes("--list")) {
  const tier = opt("tier");
  for (const e of ledger.filter((x) => !tier || x.tier === tier)) {
    console.log(`${e.id}  ${e.commit}${e.dirty ? "*" : ""}  $${e.costUsd}  ${JSON.stringify(e.config).slice(0, 60)}`);
  }
  process.exit(0);
}

const show = (a: LedgerEntry, b: LedgerEntry) => {
  console.log(
    `\n== ${a.tier} ${a.suite}: ${a.label} (${a.commit}${a.dirty ? "*" : ""}) → ${b.label} (${b.commit}${b.dirty ? "*" : ""})`,
  );
  for (const k of Object.keys(a.metrics)) {
    if (!(k in b.metrics) || (filter && !filter.some((f) => k.includes(f)))) continue;
    const x = a.metrics[k]!;
    const y = b.metrics[k]!;
    const d = y - x;
    const mark = d === 0 ? "" : d > 0 ? "▲" : "▼";
    console.log(
      `  ${k.padEnd(44)} ${String(x).padStart(10)} → ${String(y).padStart(10)}  ${mark}${d === 0 ? "" : Math.abs(Number(d.toFixed(4)))}`,
    );
  }
};

const latest = args.indexOf("--latest");
if (latest >= 0) {
  const [la, lb] = [args[latest + 1]!, args[latest + 2]!];
  const keys = new Set(ledger.map((e) => `${e.tier}|${e.suite}`));
  for (const key of keys) {
    const pick = (label: string) => ledger.filter((e) => `${e.tier}|${e.suite}` === key && e.label === label).at(-1);
    const a = pick(la);
    const b = pick(lb);
    if (a && b) show(a, b);
  }
} else {
  const [ia, ib] = args.filter((x) => !x.startsWith("--") && x !== opt("metrics"));
  const a = ledger.find((e) => e.id === ia);
  const b = ledger.find((e) => e.id === ib);
  if (!a || !b) throw new Error("usage: bench-compare.ts <id-a> <id-b> | --latest <label-a> <label-b> | --list");
  show(a, b);
}
