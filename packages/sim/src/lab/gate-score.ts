/**
 * P2 (D820): how many messages of a gate set start the push, with `pushIndirect` off and on, by kind.
 *
 *   bun packages/sim/src/lab/gate-score.ts packages/sim/lab/p2/blind-gate-2.json [--misses]
 *
 * A set is a JSON array of `{ kind, lang?, text }` (written blind by a Haiku subagent, docs/research/p2-push-check.md
 * §1.3; `gate-negatives.ts` is the fitted set). Counts "listed", "opened" and "none" per kind; `--misses` prints the
 * indirect requests that start nothing and the other kinds' messages that start a push, with the switch on.
 */
import { readFileSync } from "node:fs";
import { pushStart } from "@eden/engine";

const ACTING = new Set(["indirect", "imperative", "foreign"]);

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("usage: gate-score.ts SET.json [--misses]");
  process.exit(2);
}
const rows: { kind: string; lang?: string; text: string }[] = JSON.parse(readFileSync(file, "utf8"));
const how = (text: string, indirect: boolean) => pushStart(text, { open: true, indirect })?.how ?? "none";
for (const indirect of [false, true]) {
  const counts = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const k = r.lang && r.lang !== "en" ? `${r.kind}:${r.lang}` : r.kind;
    const c = counts.get(k) ?? {};
    const h = how(r.text, indirect);
    c[h] = (c[h] ?? 0) + 1;
    counts.set(k, c);
  }
  console.log(`pushIndirect ${indirect ? "on" : "off"}`);
  for (const [k, c] of counts) {
    const n = Object.values(c).reduce((a, b) => a + b, 0);
    console.log(`  ${k.padEnd(16)} start a push ${n - (c.none ?? 0)} of ${n}  ${JSON.stringify(c)}`);
  }
}
if (rest.includes("--misses"))
  for (const r of rows) {
    const h = how(r.text, true);
    if (ACTING.has(r.kind) ? h === "none" : h !== "none") console.log(`${r.kind}\t${h}\t${r.text}`);
  }
