#!/usr/bin/env bun
/**
 * M10 (lab only): the hard gates on the engine's own micro tagger (the shipped weights, `microCardOf`): M3's 52 short
 * constraints flagged (at least Haiku's mean over two readings, 37), and every M10 field fixture passing.
 *
 *   bun packages/sim/src/lab/m10/gates.ts [--weights FILE]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextItem } from "@eden/protocol";
import { microCardNet, microCardOf } from "./reader";

const argv = process.argv.slice(2);
const weights = argv.includes("--weights") ? argv[argv.indexOf("--weights") + 1] : undefined;
const net = weights ? microCardNet(weights) : microCardNet();
if (!net) throw new Error("no weights");
const LAB = join(import.meta.dir, "..", "..", "..", "lab");
const NOW = "2026-10-26";
const read = (p: string) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { title: string; text: string; dated?: string; expect?: Record<string, unknown> });
const itemOf = (f: { title: string; text: string; dated?: string }, i: number): ContextItem => ({
  id: `f${i}`,
  sourceId: "mail",
  ref: `f${i}`,
  title: f.title,
  text: f.text,
  updatedAt: Date.parse(`${f.dated ?? NOW}T09:00:00Z`),
});
const short = read(join(LAB, "m3r", "short-constraints.jsonl"));
const flagged = short.filter((f, i) => microCardOf(net, itemOf(f, i), NOW).kind !== "none").length;
const fails: string[] = [];
read(join(LAB, "m10", "field-fixtures.jsonl")).forEach((f, i) => {
  const c = microCardOf(net, itemOf(f, i), f.dated ?? NOW);
  const e = f.expect!;
  let ok = (c.kind !== "none") === e.flag;
  if (ok && e.flag) {
    for (const k of ["start", "end", "limit"] as const) if (k in e && c[k] !== e[k]) ok = false;
    if (Array.isArray(e.actions) && !e.actions.some((a) => c.actions.includes(a))) ok = false;
    const ents = c.entities.join(" | ").toLowerCase();
    if (Array.isArray(e.entities_any) && !e.entities_any.some((x: string) => ents.includes(x.toLowerCase())))
      ok = false;
  }
  if (!ok) fails.push(`${f.title}: ${JSON.stringify(c)}`);
});
console.log(
  `short constraints flagged ${flagged}/${short.length} (gate >= 37); field fixtures failing ${fails.length}`,
);
for (const f of fails) console.log(`  ${f}`);
