/**
 * F2's subagent-simulated pilot (docs/research/f2-push-recall.md §5): the push check's exact prompts for a stratified
 * sample of recorded rows, one file a (arm, batch), every arm the same rows in the same order. Rows: every hidden check
 * whose pool held the planted item and dropped it, as many hidden checks that kept it, control checks with the
 * look-alike in the pool, and neutral checks; seed 41–42 dumps of train, reworded and longtail only.
 *
 *   bun packages/sim/lab/f2-recall/pilot-build.ts OUTDIR DUMP.jsonl…
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CHECK_SYSTEM, checkMessages, type PushCheckInput } from "@eden/engine";
import { ARM_SYSTEMS } from "./arms";

const [out, ...files] = process.argv.slice(2);
interface Row {
  suite: string;
  seed: number;
  template: string;
  variant: string;
  planted: string;
  request: string;
  today: string;
  items: Omit<PushCheckInput["items"][number], "hash">[];
  yes: string[] | null;
}
const rows: Row[] = files.flatMap((f) =>
  readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row),
);
// A fixed shuffle (a linear congruential generator), so the sample is the same on every build.
let state = 20261112;
const rand = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const shuffle = <T>(xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};
const answered = rows.filter((r) => r.yes !== null);
const inPool = (r: Row) => r.items.some((it) => it.id === r.planted);
const dropped = answered.filter((r) => r.variant === "hidden" && inPool(r) && !r.yes!.includes(r.planted));
const kept = shuffle(answered.filter((r) => r.variant === "hidden" && inPool(r) && r.yes!.includes(r.planted)));
const control = shuffle(answered.filter((r) => r.variant === "control" && inPool(r)));
const neutral = shuffle(answered.filter((r) => r.variant === "neutral"));
const sample = shuffle([...dropped, ...kept.slice(0, 29), ...control.slice(0, 30), ...neutral.slice(0, 30)]);
const ARMS: Record<string, string> = { W: CHECK_SYSTEM, W2: CHECK_SYSTEM, ...ARM_SYSTEMS };
const BATCH = 24;
mkdirSync(out!, { recursive: true });
const meta = sample.map((r, n) => ({
  id: n,
  variant: r.variant,
  template: r.template,
  suite: r.suite,
  seed: r.seed,
  planted: r.planted,
  items: r.items.map((it) => it.id),
  recorded: r.yes,
  stratum: dropped.includes(r) ? "dropped" : r.variant === "hidden" ? "kept" : r.variant,
}));
writeFileSync(`${out}/meta.json`, JSON.stringify(meta));
for (const [arm, system] of Object.entries(ARMS))
  for (let b = 0; b * BATCH < sample.length; b++) {
    const prompts = sample.slice(b * BATCH, (b + 1) * BATCH).map((r, k) => {
      const input = { request: r.request, today: r.today, items: r.items.map((it) => ({ ...it, hash: "" })) };
      return { id: b * BATCH + k, user: checkMessages(input)[1]!.content };
    });
    writeFileSync(`${out}/${arm}-${b}.json`, JSON.stringify({ system, prompts }, null, 1));
  }
console.log(`rows ${sample.length}: dropped ${dropped.length}, kept 29, control 30, neutral 30; batches of ${BATCH}`);
