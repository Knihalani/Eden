// F9 (D1101): a seeded random 96 of the recorded API check rows (`--check-dump` lines, e.g. F2's base-dumps-4142)
// as check-fidelity.py input: bun packages/sim/lab/subagent/fidelity/random-rows.ts DUMP.jsonl OUT_DIR
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CHECK_SYSTEM, checkMessages } from "@eden/engine";
const [file, out] = process.argv.slice(2);
const rows = readFileSync(file!, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
let s = 7;
const rand = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = rows
  .filter((r) => r.yes !== null)
  .map((r) => [rand(), r] as const)
  .sort((a, b) => a[0] - b[0])
  .slice(0, 96)
  .map((x) => x[1]);
mkdirSync(out!, { recursive: true });
const meta = pick.map((r, id) => ({
  id,
  stratum: r.variant === "hidden" ? "kept" : r.variant === "control" ? "control" : "neutral",
  planted: r.planted,
  items: r.items.map((it: { id: string }) => it.id),
  recorded: r.yes,
}));
writeFileSync(`${out}/meta.json`, JSON.stringify(meta));
for (let b = 0; b < 4; b++) {
  const prompts = pick.slice(b * 24, (b + 1) * 24).map((r, k) => ({
    id: b * 24 + k,
    user: checkMessages({
      request: r.request,
      today: r.today,
      items: r.items.map((it: object) => ({ ...it, hash: "" })),
    })[1]!.content,
  }));
  writeFileSync(`${out}/W-${b}.json`, JSON.stringify({ system: CHECK_SYSTEM, prompts }));
}
console.log(pick.length, pick.filter((r) => r.variant === "hidden").length, "hidden");
