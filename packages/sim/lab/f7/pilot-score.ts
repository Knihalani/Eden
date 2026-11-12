/**
 * F7: scores the subagent-simulated pilot (docs/research/f7-cost-latency.md §5). Each prompt `k` was answered once
 * as shipped (W) and once lean (Y) by separate Haiku subagents (`out-k-W.json`, `out-k-Y.json`); the lean reply is
 * cut at its first no as `CHECK_LEAN_STOP` would and closed by `closeLean`. Per arm: output tokens a call (characters
 * / 4: a subagent reports none), planted named on hidden rows, look-alike named on control rows, neutral rows with a
 * yes; and [EST] the check's modelled wait (H3's fit, 596 ms + 2.93 ms a token) and $ a call (Haiku 5.5 list prices,
 * the pool's tokens from the recorded ledger mean).
 *
 *   bun packages/sim/lab/f7/pilot-score.ts .local/f7/pilot
 */
import { existsSync, readFileSync } from "node:fs";
import { CHECK_LEAN_STOP, closeLean, parseCompare } from "../../../engine/src/push-check";

const dir = process.argv[2] ?? ".local/f7/pilot";
const meta = JSON.parse(readFileSync(`${dir}/meta.json`, "utf8")) as {
  k: number;
  variant: string;
  planted: string;
  ids: string[];
}[];
const cut = (t: string) => {
  let at = t.length;
  for (const s of CHECK_LEAN_STOP) {
    const i = t.indexOf(s);
    if (i >= 0) at = Math.min(at, i);
  }
  return at < t.length ? closeLean(t.slice(0, at)) : t;
};
const T = (s: string) => Math.ceil(s.length / 4);
const tally: Record<string, { n: number; out: number; planted: number; decoy: number; neutralYes: number }> = {
  W: { n: 0, out: 0, planted: 0, decoy: 0, neutralYes: 0 },
  Y: { n: 0, out: 0, planted: 0, decoy: 0, neutralYes: 0 },
};
const rows: string[] = [];
let pairs = 0;
let hidden = 0;
let control = 0;
let neutral = 0;
for (const m of meta) {
  const files = ["W", "Y"].map((a) => `${dir}/out-${m.k}-${a}.json`);
  if (!files.every(existsSync)) continue;
  pairs++;
  hidden += +(m.variant === "hidden");
  control += +(m.variant === "control");
  neutral += +(m.variant === "neutral");
  const line: string[] = [`${m.k} ${m.variant}`];
  for (const arm of ["W", "Y"] as const) {
    const raw = readFileSync(files[arm === "W" ? 0 : 1]!, "utf8").trim();
    const text = arm === "Y" ? cut(raw) : raw;
    // What the model writes before the stop is what is billed and waited on; past the stop nothing is generated.
    const written =
      arm === "Y"
        ? raw.slice(0, Math.min(...CHECK_LEAN_STOP.map((s) => (raw.indexOf(s) + 1 || raw.length + 1) - 1)))
        : raw;
    const at = parseCompare(text, m.ids.length);
    const yes = new Set((at ?? []).map((i) => m.ids[i]!));
    const t = tally[arm]!;
    t.n++;
    t.out += T(written);
    if (m.variant === "hidden" && yes.has(m.planted)) t.planted++;
    if (m.variant === "control" && yes.has(m.planted)) t.decoy++;
    if (m.variant === "neutral" && yes.size) t.neutralYes++;
    line.push(`${arm}: ${at === null ? "unreadable" : yes.size} yes, ${T(written)} tok`);
  }
  rows.push(line.join(" | "));
}
console.log(rows.join("\n"));
console.log(`pairs ${pairs} (hidden ${hidden}, control ${control}, neutral ${neutral}), subagent-simulated`);
// [EST] the pool's input from the recorded ledger (§3): 2,490 input tokens of which 1,185 the cached instructions.
const IN = 2490 - 1185;
for (const [arm, t] of Object.entries(tally)) {
  const out = t.out / t.n;
  const usd = (IN * 0.1 + 1185 * 0.01 + out * 0.5) / 1e6;
  console.log(
    `${arm}: output tokens a call ${out.toFixed(1)}; planted named ${t.planted}/${hidden}, look-alike named ` +
      `${t.decoy}/${control}, neutral with a yes ${t.neutralYes}/${neutral}; [EST] wait ${(596 + 2.93 * out).toFixed(0)} ms, ` +
      `$ a call ${usd.toFixed(6)}`,
  );
}
