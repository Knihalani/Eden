import type { StretchTrace, Refusal } from "./types";
import { REFUSAL_LABELS, refusalStatus } from "./refusal";

/** Campaign-named causes for “why didn’t anything compile?” — not per-candidate IR refusals. */
export const HONESTY_CODES = [
  "nothing_recorded",
  "high_entropy",
  "under_support",
  "width_split",
  "envelope_gap",
] as const;

export type HonestyCode = (typeof HONESTY_CODES)[number];

export const HONESTY_LABELS: Record<HonestyCode, string> = {
  nothing_recorded: "Nothing recorded",
  high_entropy: "Unique work",
  under_support: REFUSAL_LABELS.too_short,
  width_split: "Width split",
  envelope_gap: "Envelope gap",
};

export const HONESTY_MIN_SUPPORT = 3;
export const HONESTY_MIN_STEPS = 3;

export type HonestyFinding = {
  code: HonestyCode;
  label: string;
  /** What we observed (the count that fell short, or 0 when nothing exists). */
  have: number;
  /** What the campaign fixture pinned as enough. */
  need: number;
  /** How many stretches this finding covers. Omitted when it is the whole set. */
  count?: number;
  /** One line: class facts a person can check. */
  detail: string;
};

function okNames(t: StretchTrace): string[] {
  const events = Array.isArray(t?.events) ? t.events : [];
  const out: string[] = [];
  for (const e of events) {
    if (!e || e.ok === false || e.skipped) continue;
    if (typeof e.name === "string" && e.name) out.push(e.name);
  }
  return out;
}

/** Collapsed tool identity: consecutive repeats fold. Width-4 and width-5 share a shape. */
export function honestyShape(seq: string[]): string {
  const out: string[] = [];
  for (const n of seq) if (out.at(-1) !== n) out.push(n);
  return out.join("\0");
}

/** Max consecutive repeat — the fan-out width. A linear stretch is width 1. */
export function honestyWidth(seq: string[]): number {
  if (!seq.length) return 0;
  let max = 1;
  let cur = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1]) {
      cur++;
      if (cur > max) max = cur;
    } else cur = 1;
  }
  return max;
}

function entityKey(t: StretchTrace): string {
  const input = t.input && typeof t.input === "object" && !Array.isArray(t.input) ? t.input : {};
  for (const k of ["id", "issue", "order", "ticket", "customer", "run_id", "invoice"]) {
    const v = input[k];
    if (typeof v === "string" || typeof v === "number") return `${k}:${v}`;
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

/**
 * Diagnose a recorded set the way the campaign named the causes.
 * Never invents a class. Empty input is `nothing_recorded` with have 0.
 */
export function diagnoseHonesty(traces: StretchTrace[]): HonestyFinding[] {
  const list = Array.isArray(traces) ? traces.filter(Boolean) : [];
  if (!list.length) {
    return [
      {
        code: "nothing_recorded",
        label: HONESTY_LABELS.nothing_recorded,
        have: 0,
        need: 1,
        detail: "0 stretches",
      },
    ];
  }

  const named = list.map((t) => {
    const names = okNames(t);
    return { t, names, shape: honestyShape(names), width: honestyWidth(names) };
  });
  const findings: HonestyFinding[] = [];

  const short = named.filter((x) => x.names.length < HONESTY_MIN_STEPS);
  if (short.length) {
    const typical = short.reduce((m, x) => Math.max(m, x.names.length), 0);
    findings.push({
      code: "under_support",
      label: HONESTY_LABELS.under_support,
      have: typical,
      need: HONESTY_MIN_STEPS,
      count: short.length,
      detail: `${short.length} stretches of ${typical} calls (need ${HONESTY_MIN_STEPS})`,
    });
  }

  const seqKeys = named.map((x) => x.names.join("\0"));
  const uniqueSeq = new Set(seqKeys);
  if (list.length >= HONESTY_MIN_SUPPORT && uniqueSeq.size === list.length) {
    findings.push({
      code: "high_entropy",
      label: HONESTY_LABELS.high_entropy,
      have: uniqueSeq.size,
      need: HONESTY_MIN_SUPPORT,
      count: list.length,
      detail: `${uniqueSeq.size} distinct sequences in ${list.length} stretches`,
    });
  }

  const byShape = new Map<string, typeof named>();
  for (const row of named) {
    if (!row.shape) continue;
    const g = byShape.get(row.shape);
    if (g) g.push(row);
    else byShape.set(row.shape, [row]);
  }

  for (const rows of byShape.values()) {
    if (rows.length < 2) continue;
    const byWidth = new Map<number, typeof named>();
    for (const row of rows) {
      const g = byWidth.get(row.width);
      if (g) g.push(row);
      else byWidth.set(row.width, [row]);
    }
    if (byWidth.size < 2) continue;
    for (const [w, group] of byWidth) {
      if (group.length > 0 && group.length < HONESTY_MIN_SUPPORT) {
        findings.push({
          code: "width_split",
          label: HONESTY_LABELS.width_split,
          have: group.length,
          need: HONESTY_MIN_SUPPORT,
          count: group.length,
          detail: `${group.length} of ${HONESTY_MIN_SUPPORT} same-shape at width ${w}`,
        });
        break;
      }
    }
  }

  for (const rows of byShape.values()) {
    if (rows.length < HONESTY_MIN_SUPPORT) continue;
    const ids = rows.map((r) => entityKey(r.t));
    const uniqueIds = new Set(ids.filter(Boolean));
    if (uniqueIds.size === rows.length) {
      findings.push({
        code: "envelope_gap",
        label: HONESTY_LABELS.envelope_gap,
        have: 1,
        need: HONESTY_MIN_SUPPORT,
        count: uniqueIds.size,
        detail: `${uniqueIds.size} novel ids, 0 repeats (need ${HONESTY_MIN_SUPPORT} of the same id)`,
      });
    }
  }

  return findings;
}

export type HonestyLetterInput = {
  findings: HonestyFinding[];
  refusals?: Array<Pick<Refusal, "code" | "reason" | "readSet" | "repeats">>;
  live?: number;
  /** Partitioned Canary/Live line. A canary tool is never also Live. */
  serving?: string;
};

/**
 * One letter. Same words as Home Needs attention for per-candidate refusals.
 * Honest 0. Never invents a class.
 */
export function renderHonestyLetter(input: HonestyLetterInput): string {
  const findings = input.findings ?? [];
  const refusals = input.refusals ?? [];
  const live = Number.isFinite(input.live) ? Math.max(0, Math.round(input.live!)) : 0;
  const inventory = input.serving?.trim() || `${live} programs`;
  const onlyEmpty = findings.length === 1 && findings[0]!.code === "nothing_recorded";

  if (onlyEmpty) {
    return [
      "Nothing recorded.",
      "",
      `  ${HONESTY_LABELS.nothing_recorded} · 0 stretches`,
      "",
      "Run your agent. Eden records automatically.",
      "Then come back: eden explain",
    ].join("\n");
  }

  if (!findings.length && !refusals.length) {
    return [
      "Nothing waiting.",
      "",
      `  0 refusals · ${inventory}`,
      "",
      "eden doctor",
    ].join("\n");
  }

  const lines: string[] = ["Nothing compiled.", ""];
  for (const f of findings) {
    if (f.code === "nothing_recorded") continue;
    lines.push(`  ${f.label} · ${f.detail}`);
  }
  for (const r of refusals) {
    lines.push(`  ${refusalStatus(r)}`);
  }
  if (lines[lines.length - 1] !== "") lines.push("");
  const next = findings.find((f) => f.code !== "nothing_recorded")?.code;
  if (next === "high_entropy") lines.push("Nothing was lost. Unique work stays raw.");
  else if (next === "under_support") lines.push("Wrap a stretch of at least three steps.");
  else if (next === "width_split") lines.push("Need three of the same fan-out width.");
  else if (next === "envelope_gap") lines.push("The same id must repeat inside the envelope.");
  else lines.push("Wrap more runs that repeat, or expose the full array the loop iterates.");
  return lines.join("\n");
}
