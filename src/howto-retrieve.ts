/**
 * How-to retrieve: ranked skills plus named unknown gaps. Incomplete ≠ invent a step.
 * M12 may import this; this file does not format `[procedure]` or touch inject.
 * HowToStore resolves a session subdirectory to the memory root, so wrap-put
 * and hook-inject read the same howto.jsonl / the same id.
 */
import { HowToStore, omitStalePlace, resolveHowToDir, type HowTo, type HowToGap, type HowToStep } from "./howto-store";
import { loadHarmedIds } from "./memory-harmed";

/** Throw or unreadable store → null (caller leaves rows unfiltered). */
function harmedIdsOrSkip(root: string): Set<string> | null {
  try {
    const ids = loadHarmedIds(root);
    return ids instanceof Set ? ids : null;
  } catch {
    return null;
  }
}

export type { HowToGap };

export type HowToView = HowTo & { gaps: HowToGap[] };

export const HOWTO_RETRIEVE_K = 3;
/** ~300 tokens; enforce via char budget ~1200. */
export const HOWTO_TOKEN_CAP = 300;

const CHAR_BUDGET = HOWTO_TOKEN_CAP * 4;
const SHELL_STEP = /^(bash|shell|terminal|zsh|sh)$/i;
const CMD_KEYS = ["command", "cmd", "script"] as const;
const PLACE_KEYS = ["path", "file", "filepath", "filename", "selector"] as const;
/** Command-shaped text must never appear in a gap (data hole, not an instruction). */
const FORBIDDEN_GAP = /\bpytest\b|\bnpm\b|\brm\s|\bcd\s|\bbash\s|[|;&]/i;

export function retrieveHowTo(
  dir: string,
  cue: string,
  opts?: { k?: number; exists?: (file: string) => boolean; cwd?: string },
): HowToView[] {
  try {
    const q = String(cue ?? "").trim();
    if (!q) return [];
    const k = capK(opts?.k);
    if (!k) return [];
    let root = dir;
    try {
      root = resolveHowToDir(dir);
    } catch {
      root = dir;
    }
    // Session jsonlDir still reads the memory-root howto.jsonl wrap wrote.
    const rows = new HowToStore(root).latest(q, k);
    if (!Array.isArray(rows) || !rows.length) return [];
    let live = rows;
    const harmed = harmedIdsOrSkip(root);
    if (harmed && harmed.size) {
      live = rows.filter((row) => {
        try {
          return !(row?.id && harmed.has(row.id));
        } catch {
          return true;
        }
      });
    }
    const out: HowToView[] = [];
    for (const row of live) {
      try {
        out.push(viewHowTo(row, opts));
      } catch {
        // Skip a torn row; do not fail the whole retrieve.
      }
    }
    return out;
  } catch {
    return [];
  }
}

function capK(k?: number): number {
  if (k === undefined) return HOWTO_RETRIEVE_K;
  const n = Math.floor(Number(k));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(HOWTO_RETRIEVE_K, n);
}

function viewHowTo(row: HowTo, opts?: { exists?: (file: string) => boolean; cwd?: string }): HowToView {
  const omitted = applyOmit(row, opts);
  const view: HowToView = {
    ...row,
    steps: omitted.steps.slice(),
    files: omitted.files.slice(),
    gaps: omitted.gaps.map(copyGap),
  };
  view.steps = dropEmptyNames(view.steps, view.gaps);
  markShellHoles(view.steps, view.gaps);
  markOrderHoles(view.steps, view.gaps);
  markUnnamedPlaces(view.files, view.steps, view.gaps);
  if (!view.steps.length && (view.verify || view.files.length)) {
    pushGap(view.gaps, { kind: "unknown", reason: "missing step" });
  }
  view.gaps = dedupeGaps(view.gaps);
  capTokens(view);
  return view;
}

function applyOmit(
  row: HowTo,
  opts?: { exists?: (file: string) => boolean; cwd?: string },
): { steps: HowToStep[]; files: string[]; gaps: HowToGap[] } {
  try {
    if (typeof omitStalePlace === "function") {
      const out = omitStalePlace(row, { exists: opts?.exists, cwd: opts?.cwd });
      if (out && Array.isArray(out.steps) && Array.isArray(out.files) && Array.isArray(out.gaps)) {
        return { steps: out.steps, files: out.files, gaps: out.gaps.map(copyGap) };
      }
    }
  } catch {
    // M11.3 owns canonical omit; fall through to a tiny local drop.
  }
  return fallbackOmit(row, opts);
}

/** Tiny fallback if omitStalePlace is missing or throws. M11.3 owns the canonical omit. */
function fallbackOmit(
  row: HowTo,
  opts?: { exists?: (file: string) => boolean; cwd?: string },
): { steps: HowToStep[]; files: string[]; gaps: HowToGap[] } {
  const stepsIn = Array.isArray(row?.steps) ? row.steps : [];
  const filesIn = Array.isArray(row?.files) ? row.files : [];
  if (typeof opts?.exists !== "function") return { steps: stepsIn, files: filesIn, gaps: [] };
  const gone = (file: string): boolean => {
    try {
      return !opts.exists!(file);
    } catch {
      return false;
    }
  };
  const kept: HowToStep[] = [];
  const gaps: HowToGap[] = [];
  for (const s of stepsIn) {
    const files = (s.files ?? []).filter((f): f is string => typeof f === "string" && !!f.trim());
    if (files.length && files.some(gone)) {
      const place = safeGapText(files[0]!.trim());
      const gap: HowToGap = { kind: "unknown", reason: "missing place" };
      if (place) gap.place = place;
      pushGap(gaps, gap);
      continue;
    }
    kept.push(s);
  }
  const files = filesIn.filter((f) => typeof f === "string" && f.trim() && !gone(f));
  return { steps: kept, files, gaps };
}

function dropEmptyNames(steps: HowToStep[], gaps: HowToGap[]): HowToStep[] {
  const kept: HowToStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const name = typeof steps[i]?.name === "string" ? steps[i]!.name.trim() : "";
    if (!name) {
      pushGap(gaps, neighborGap(steps, i, "missing step"));
      continue;
    }
    kept.push(steps[i]!);
  }
  return kept;
}

function markShellHoles(steps: HowToStep[], gaps: HowToGap[]): void {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (!SHELL_STEP.test(String(step.name || "").trim())) continue;
    if (commandArg(step.args)) continue;
    pushGap(gaps, neighborGap(steps, i, "missing step"));
  }
}

function commandArg(args?: Record<string, unknown>): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  for (const k of CMD_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function markOrderHoles(steps: HowToStep[], gaps: HowToGap[]): void {
  const ordered: { order: number; name: string }[] = [];
  for (const s of steps) {
    const order = s.order;
    if (typeof order !== "number" || !Number.isFinite(order)) continue;
    ordered.push({ order, name: typeof s.name === "string" ? s.name.trim() : "" });
  }
  ordered.sort((a, b) => a.order - b.order);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const next = ordered[i]!;
    const holes = Math.floor(next.order) - Math.floor(prev.order) - 1;
    if (holes <= 0) continue;
    for (let n = 0; n < holes; n++) {
      const gap: HowToGap = { kind: "unknown", reason: "missing step" };
      const after = safeGapText(prev.name);
      const before = safeGapText(next.name);
      if (after) gap.after = after;
      if (before) gap.before = before;
      pushGap(gaps, gap);
    }
  }
}

function markUnnamedPlaces(files: string[], steps: HowToStep[], gaps: HowToGap[]): void {
  for (const raw of files) {
    if (typeof raw !== "string") continue;
    const file = raw.trim();
    if (!file) continue;
    if (steps.some((s) => stepNamesPlace(s, file))) continue;
    const gap: HowToGap = { kind: "unknown", reason: "missing place" };
    const place = safeGapText(file);
    if (place) gap.place = place;
    pushGap(gaps, gap);
  }
}

function stepNamesPlace(step: HowToStep, file: string): boolean {
  const want = file.trim();
  if (!want) return false;
  for (const f of step.files ?? []) {
    if (typeof f === "string" && samePlace(f, want)) return true;
  }
  const args = step.args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const k of PLACE_KEYS) {
      const v = args[k];
      if (typeof v === "string" && samePlace(v, want)) return true;
    }
  }
  return false;
}

function samePlace(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  if (x === y) return true;
  const bx = x.split(/[/\\]/).pop() || x;
  const by = y.split(/[/\\]/).pop() || y;
  return bx === by;
}

function capTokens(view: HowToView): void {
  if (payloadChars(view.steps, view.verify) <= CHAR_BUDGET) return;
  while (payloadChars(view.steps, view.verify) > CHAR_BUDGET) {
    const withoutVerify = payloadChars(view.steps, undefined);
    if (view.verify && withoutVerify <= CHAR_BUDGET) {
      delete view.verify;
      break;
    }
    if (!view.steps.length) {
      if (view.verify) delete view.verify;
      break;
    }
    view.steps.pop();
  }
  pushGap(view.gaps, { kind: "unknown", reason: "truncated" });
}

function payloadChars(steps: HowToStep[], verify?: string): number {
  try {
    return JSON.stringify({ steps, verify }).length;
  } catch {
    return CHAR_BUDGET + 1;
  }
}

function neighborGap(steps: HowToStep[], i: number, reason: string): HowToGap {
  const gap: HowToGap = { kind: "unknown", reason };
  for (let j = i - 1; j >= 0; j--) {
    const after = safeGapText(typeof steps[j]?.name === "string" ? steps[j]!.name : "");
    if (after) {
      gap.after = after;
      break;
    }
  }
  for (let j = i + 1; j < steps.length; j++) {
    const before = safeGapText(typeof steps[j]?.name === "string" ? steps[j]!.name : "");
    if (before) {
      gap.before = before;
      break;
    }
  }
  return gap;
}

function copyGap(g: { kind?: string; reason?: string; after?: string; before?: string; place?: string }): HowToGap {
  const gap: HowToGap = {
    kind: "unknown",
    reason: typeof g.reason === "string" && g.reason.trim() ? g.reason.trim() : "missing step",
  };
  const after = typeof g.after === "string" ? safeGapText(g.after) : undefined;
  const before = typeof g.before === "string" ? safeGapText(g.before) : undefined;
  const place = typeof g.place === "string" ? safeGapText(g.place) : undefined;
  if (after) gap.after = after;
  if (before) gap.before = before;
  if (place) gap.place = place;
  if (FORBIDDEN_GAP.test(gap.reason)) gap.reason = gap.place ? "missing place" : "missing step";
  return gap;
}

function safeGapText(s: string): string | undefined {
  const t = String(s || "").trim();
  if (!t || FORBIDDEN_GAP.test(t)) return undefined;
  return t;
}

function pushGap(gaps: HowToGap[], gap: HowToGap): void {
  const key = gapKey(gap);
  if (gaps.some((g) => gapKey(g) === key)) return;
  gaps.push(gap);
}

function dedupeGaps(gaps: HowToGap[]): HowToGap[] {
  const out: HowToGap[] = [];
  const seen = new Set<string>();
  for (const g of gaps) {
    const k = gapKey(g);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

function gapKey(g: HowToGap): string {
  return `${g.kind}\0${g.reason}\0${g.after ?? ""}\0${g.before ?? ""}\0${g.place ?? ""}`;
}
