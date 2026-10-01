/**
 * Rendering a decision so that the caveats are as visible as the number.
 *
 * The failure mode this guards against is a headline percentage travelling
 * without its interval. "45% faster" survived into commit messages and result
 * files; "76% of that came from a cell where the treatment was switched off"
 * did not, because nothing printed it.
 */
import type { Decision, Verdict } from "./verdict";

const MARK: Record<Verdict, string> = {
  WIN: "WIN",
  LOSS: "LOSS",
  INDISTINGUISHABLE: "NO CALL",
  UNTRUSTWORTHY_INSTRUMENT: "INVALID",
  INSUFFICIENT_DATA: "NO DATA",
};

function pct(x: number): string {
  if (!Number.isFinite(x)) return "n/a";
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

export function formatDecision(name: string, d: Decision, unit = "ms"): string {
  const lines: string[] = [];
  lines.push(`${MARK[d.verdict].padEnd(8)} ${name}`);
  lines.push(
    `  control ${d.controlMean.toFixed(0)}${unit}  treatment ${d.treatmentMean.toFixed(0)}${unit}  ` +
      `delta ${d.delta.point.toFixed(0)}${unit} (${pct(d.relative.point)})`,
  );
  if (Number.isFinite(d.delta.lo) && Number.isFinite(d.delta.hi)) {
    lines.push(
      `  95% CI ${d.delta.lo.toFixed(0)}..${d.delta.hi.toFixed(0)}${unit} ` +
        `(${pct(d.relative.lo)}..${pct(d.relative.hi)})   p=${d.p.toFixed(4)}   n=${d.blocks}`,
    );
  }
  if (Number.isFinite(d.mde)) {
    lines.push(
      `  detectable at this n: ±${d.mde.toFixed(0)}${unit} ` +
        `(${((d.mde / (d.controlMean || 1)) * 100).toFixed(1)}% of control)`,
    );
  }
  if (d.selfCheck) {
    const s = d.selfCheck;
    lines.push(
      `  A/A self-check: ${s.status} ` +
        `(delta ${s.delta.point.toFixed(0)}${unit}, CI ${s.delta.lo.toFixed(0)}..${s.delta.hi.toFixed(0)}, ` +
        `n=${s.blocks})`,
    );
  }
  for (const r of d.reasons) lines.push(`  - ${r}`);
  return lines.join("\n");
}
