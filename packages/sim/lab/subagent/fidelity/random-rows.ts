// F9 (D1101, D1104): a seeded random sample of recorded API check rows (`--check-dump` lines, e.g. F2's
// base-dumps-4142) as check-fidelity.py input, from one half of check-api-replay.ts's fixed split:
//   bun packages/sim/lab/subagent/fidelity/random-rows.ts DUMP.jsonl[.gz] OUT_DIR [--half tune|test|all] [--n 96]
//     [--seed 7] [--batch 24]
import { mkdirSync, writeFileSync } from "node:fs";
import { CHECK_SYSTEM } from "@eden/engine";
import { checkRequest, halfOf, readDump } from "../../../src/lab/check-api-replay";

const [file, out] = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const half = opt("half", "all");
const n = Number(opt("n", "96"));
const batch = Number(opt("batch", "24"));
let s = Number(opt("seed", "7"));
const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = readDump(file!)
  .filter((r) => r.yes !== null && (half === "all" || halfOf(r) === half))
  .map((r) => [rand(), r] as const)
  .sort((a, b) => a[0] - b[0])
  .slice(0, n)
  .map((x) => x[1]);
mkdirSync(out!, { recursive: true });
const stratum = (v: string) => (v === "hidden" ? "kept" : v === "control" ? "control" : "neutral");
const meta = pick.map((r, id) => ({
  id,
  stratum: stratum(r.variant),
  planted: r.planted,
  items: r.items.map((it) => it.id),
  recorded: r.yes,
}));
writeFileSync(`${out}/meta.json`, JSON.stringify(meta));
for (let b = 0; b * batch < pick.length; b++) {
  const prompts = pick.slice(b * batch, (b + 1) * batch).map((r, k) => ({
    id: b * batch + k,
    user: checkRequest(r).messages[1]!.content,
  }));
  writeFileSync(`${out}/W-${b}.json`, JSON.stringify({ system: CHECK_SYSTEM, prompts }));
}
console.log(`${pick.length} rows (${half}), ${pick.filter((r) => r.variant === "hidden").length} hidden → ${out}`);
