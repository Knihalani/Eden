/**
 * HowToStore: durable sleep-built skills (steps, files, verify, exit).
 * Chat-only / ICL never auto-promote here — callers decide. M10 fills compression.
 * Not src/cls/*. Persist on the memory root as howto.jsonl (like semantic/gists).
 * Session subdirs (memories.jsonl here, parent is a memory root) resolve up so
 * wrap and hook share one file — never session-namespaced, no host/session keys.
 *
 * How is not LWW the way what is (COMPETITORS §0 / Memorable L3):
 * identical steps refresh a revision; a different approach is a sibling;
 * a worse second attempt must not clobber a working first. Facts stay LWW elsewhere.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { redact } from "../packages/ir/src/redact";
import { scrubMemoryText, scrubMemoryValue } from "./memory-scrub";

export type HowToStep = {
  name: string;
  args?: Record<string, unknown>;
  files?: string[];
  exit?: number;
  order?: number;
};

/** Shared skill row. No host/session keys — wrap and hook read the same id. */
export type HowTo = {
  id: string;
  cue: string;
  steps: HowToStep[];
  files: string[];
  verify?: string;
  exit: number;
  t: number;
  wins?: number;
  family?: string;
};

const FILE = "howto.jsonl";
/** Parent is a memory root when any of these exist beside the session subdir. */
const ROOT_MARKERS = ["semantic.jsonl", "gists.jsonl", "howto.jsonl", "memories.jsonl"] as const;

/** Arg keys that distinguish an approach; schema aliases (cmd) included. */
const STABLE_ARG_KEYS = ["command", "cmd", "path", "file", "filepath", "filename"] as const;
/** Values that aboutness/inject match on — includes `script` so latest() can see schema-renamed steps. */
const SCHEMA_ARG_KEYS = new Set<string>([...STABLE_ARG_KEYS, "script"]);

function redactText(s: string): string {
  const r = redact(s);
  return scrubMemoryText(typeof r === "string" ? r : s);
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const r = redact(args);
  const rec = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : args;
  const scrubbed = scrubMemoryValue(rec);
  return scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed) ? (scrubbed as Record<string, unknown>) : rec;
}

/** Weak cue words — not enough to bind two skills into one family. */
const FAMILY_STOP = new Set([
  "the", "a", "an", "to", "of", "and", "or", "for", "fix", "how", "do", "run",
  "use", "with", "on", "in", "at", "i", "we", "my", "our", "this", "that",
  "failing", "failed", "error", "bug", "issue", "test", "tests",
]);

function jsonlFile(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isFile();
  } catch {
    return false;
  }
}

/**
 * Session subdirectory → memory root. This dir has memories.jsonl and the parent
 * looks like a memory root (semantic/gists/howto/memories.jsonl). One level only.
 * Fail-open: stat throw or a non-session dir returns `dir` unchanged.
 */
export function resolveHowToDir(dir: string): string {
  try {
    if (typeof dir !== "string") return dir;
    const d = dir.trim();
    if (!d) return dir;
    if (!jsonlFile(d, "memories.jsonl")) return d;
    const parent = dirname(d);
    if (!parent || parent === d) return d;
    for (const marker of ROOT_MARKERS) {
      if (jsonlFile(parent, marker)) return parent;
    }
    return d;
  } catch {
    return dir;
  }
}

export function howtoPath(dir: string): string {
  return join(resolveHowToDir(dir), FILE);
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ht_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function asFiles(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const s = x.trim();
    if (s) out.push(s);
  }
  return out;
}

function asStep(v: unknown): HowToStep | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  const step: HowToStep = { name };
  if (o.args && typeof o.args === "object" && !Array.isArray(o.args)) {
    step.args = redactArgs(o.args as Record<string, unknown>);
  }
  const files = asFiles(o.files);
  if (files.length) step.files = files;
  if (typeof o.exit === "number" && Number.isFinite(o.exit)) step.exit = o.exit;
  if (typeof o.order === "number" && Number.isFinite(o.order)) step.order = o.order;
  return step;
}

function asSteps(v: unknown): HowToStep[] {
  if (!Array.isArray(v)) return [];
  const out: HowToStep[] = [];
  for (const x of v) {
    const s = asStep(x);
    if (s) out.push(s);
  }
  return out;
}

function asWins(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(0, Math.floor(v));
}

function asHowTo(v: unknown): HowTo | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  const t = Number(o.t);
  if (!id || !Number.isFinite(t)) return null;
  const cue = typeof o.cue === "string" ? redactText(o.cue.trim()) : "";
  const steps = asSteps(o.steps);
  const files = asFiles(o.files);
  const exit = typeof o.exit === "number" && Number.isFinite(o.exit) ? o.exit : 0;
  const row: HowTo = { id, cue, steps, files, exit, t };
  if (typeof o.verify === "string") {
    const verify = redactText(o.verify.trim());
    if (verify) row.verify = verify;
  }
  const wins = asWins(o.wins);
  if (wins !== undefined) row.wins = wins;
  if (typeof o.family === "string") {
    const family = o.family.trim();
    if (family) row.family = family;
  }
  return row;
}

function load(path: string): HowTo[] {
  if (!existsSync(path)) return [];
  const out: HowTo[] = [];
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const row = asHowTo(JSON.parse(line));
        if (row) out.push(row);
      } catch {
        // Torn or invalid line — skip.
      }
    }
  } catch {}
  return out;
}

function persist(path: string, rows: HowTo[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileAtomic(path, body);
  try { chmodSync(path, 0o600); } catch {}
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}

function schemaArgHay(row: HowTo): string {
  const parts: string[] = [];
  for (const s of row.steps ?? []) {
    if (!s.args) continue;
    for (const [k, val] of Object.entries(s.args)) {
      if (!SCHEMA_ARG_KEYS.has(k.toLowerCase())) continue;
      if (typeof val === "string" && val.trim()) parts.push(val);
    }
  }
  return parts.join(" ");
}

function overlapScore(cue: string, row: HowTo): number {
  const q = new Set(tokens(cue));
  if (!q.size) return 0;
  const hay = new Set(tokens([row.cue, ...row.files, row.verify ?? "", schemaArgHay(row)].join(" ")));
  let n = 0;
  for (const tok of q) if (hay.has(tok)) n++;
  return n;
}

function normText(v: unknown): string {
  if (typeof v === "string") return v.trim().toLowerCase().replace(/\s+/g, " ");
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** First command/path token of verify; basename if the token is a path. */
function verifyStem(verify?: string): string {
  if (!verify) return "";
  const first = verify.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const cleaned = first.replace(/^['"]+|['"]+$/g, "");
  return (cleaned.split(/[/\\]/).pop() ?? cleaned).trim();
}

function fileKeys(files: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const base = f.trim().toLowerCase().split(/[/\\]/).pop() ?? "";
    if (!base || seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

function stableArgs(args?: Record<string, unknown>): string {
  if (!args) return "";
  const parts: string[] = [];
  for (const k of STABLE_ARG_KEYS) {
    if (!(k in args)) continue;
    const s = normText(args[k]);
    if (s) parts.push(`${k}:${s}`);
  }
  return parts.join(",");
}

/**
 * Approach identity: normalized steps (name + stable arg keys + sequence)
 * + sorted files + verify stem. Ignores id, t, and raw traces.jsonl order.
 */
function fingerprint(row: { steps: HowToStep[]; files: string[]; verify?: string }): string {
  const steps = row.steps
    .map((s, i) => {
      const seq = typeof s.order === "number" && Number.isFinite(s.order) ? s.order : i;
      return { seq, key: `${s.name.trim().toLowerCase()}|${stableArgs(s.args)}` };
    })
    .sort((a, b) => a.seq - b.seq)
    .map((s, i) => `${i}|${s.key}`);
  const files = [...row.files].map((f) => f.trim().toLowerCase()).filter(Boolean).sort();
  return `${steps.join(";")}#${files.join(",")}#${verifyStem(row.verify)}`;
}

function sharedCount(a: Iterable<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function mintFamily(row: { cue: string; files: string[]; verify?: string }): string {
  const stem = verifyStem(row.verify);
  const distinctive = tokens(row.cue)
    .filter((t) => t.length > 2 && !FAMILY_STOP.has(t) && t !== stem)
    .sort();
  const key = [stem, ...distinctive].filter(Boolean).join("+");
  if (key) return key;
  const files = fileKeys(row.files).sort().join(",");
  return files ? `files::${files}` : `htf_${newId()}`;
}

/** Same skill, maybe a different approach: cue/files/verify-stem overlap. */
function sameFamily(a: HowTo, b: HowTo): boolean {
  const fa = a.family?.trim();
  const fb = b.family?.trim();
  if (fa && fb && fa === fb) return true;

  const stemA = verifyStem(a.verify);
  const stemB = verifyStem(b.verify);
  const stemMatch = Boolean(stemA && stemB && stemA === stemB);

  const cueA = tokens(a.cue);
  const cueB = new Set(tokens(b.cue));
  let sharedCue = 0;
  let distinctive = 0;
  for (const t of cueA) {
    if (!cueB.has(t)) continue;
    sharedCue++;
    if (t.length > 2 && !FAMILY_STOP.has(t) && t !== stemA && t !== stemB) distinctive++;
  }
  const fileN = sharedCount(fileKeys(a.files), new Set(fileKeys(b.files)));

  if (distinctive >= 1 && (stemMatch || fileN > 0 || sharedCue >= 2)) return true;
  if (stemMatch && fileN > 0) return true;
  return false;
}

/** Same family id, else sameFamily, else shared verify-stem and/or files. */
function mergeKin(a: HowTo, b: HowTo): boolean {
  const fa = a.family?.trim();
  const fb = b.family?.trim();
  if (fa && fb) return fa === fb;
  if (sameFamily(a, b)) return true;
  const stemA = verifyStem(a.verify);
  const stemB = verifyStem(b.verify);
  if (stemA && stemB && stemA === stemB) return true;
  return sharedCount(fileKeys(a.files), new Set(fileKeys(b.files))) > 0;
}

/** name (ci) + stable args. Position is the prefix index, not traces.jsonl order. */
function stepSig(step: HowToStep, _index: number): string {
  return `${step.name.trim().toLowerCase()}|${stableArgs(step.args)}`;
}

function sharedPrefixLen(a: HowToStep[], b: HowToStep[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  for (; i < n; i++) {
    if (stepSig(a[i]!, i) !== stepSig(b[i]!, i)) break;
  }
  return i;
}

/** Cue already on a parent: longest shared parent cue, else first parent. Never invent. */
function pickMergeCue(a: HowTo, b: HowTo): string {
  const ca = typeof a.cue === "string" ? a.cue.trim() : "";
  const cb = typeof b.cue === "string" ? b.cue.trim() : "";
  if (ca && cb) {
    if (ca === cb) return ca;
    const max = Math.min(ca.length, cb.length);
    let n = 0;
    while (n < max && ca[n] === cb[n]) n++;
    const shared = ca.slice(0, n).trim();
    if (shared && shared === ca) return ca;
    if (shared && shared === cb) return cb;
  }
  return ca || cb;
}

/** Files named on prefix steps only — not parent row.files (those may include tails). */
function unionPrefixFiles(a: HowToStep[], b: HowToStep[], n: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const steps of [a.slice(0, n), b.slice(0, n)]) {
    for (const s of steps) {
      for (const f of s.files ?? []) {
        const t = f.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

function copyPrefixSteps(steps: HowToStep[], n: number): HowToStep[] {
  return steps.slice(0, n).map((s) => {
    const step: HowToStep = { name: s.name };
    if (s.args) step.args = s.args;
    if (s.files?.length) step.files = s.files.slice();
    if (typeof s.exit === "number" && Number.isFinite(s.exit)) step.exit = s.exit;
    if (typeof s.order === "number" && Number.isFinite(s.order)) step.order = s.order;
    return step;
  });
}

/**
 * Shared-prefix compress of two exit-0 how-tos. Steps are exactly the common
 * prefix (subset of both) — never concatenated tails, never a synthesized command.
 * Returns null if the shared prefix is shorter than 2 steps.
 */
export function mergeSharedPrefix(a: HowTo, b: HowTo): HowTo | null {
  if (!a || !b) return null;
  if (a.exit !== 0 || b.exit !== 0) return null;
  const n = sharedPrefixLen(a.steps ?? [], b.steps ?? []);
  if (n < 2) return null;
  const steps = copyPrefixSteps(a.steps, n);
  const files = unionPrefixFiles(a.steps, b.steps, n);
  const stemA = verifyStem(a.verify);
  const stemB = verifyStem(b.verify);
  const tA = Number(a.t);
  const tB = Number(b.t);
  const t = Math.max(Number.isFinite(tA) ? tA : 0, Number.isFinite(tB) ? tB : 0) || Date.now();
  const row: HowTo = {
    id: newId(),
    cue: pickMergeCue(a, b),
    steps,
    files,
    exit: 0,
    t,
  };
  if (stemA && stemB && stemA === stemB) {
    const verify = (a.verify ?? b.verify)?.trim();
    if (verify) row.verify = verify;
  }
  const fa = a.family?.trim();
  const fb = b.family?.trim();
  if (fa && fb && fa === fb) row.family = fa;
  else if (fa) row.family = fa;
  else if (fb) row.family = fb;
  return row;
}

function isWorseThanWinner(incoming: HowTo, winner: HowTo): boolean {
  if (winner.exit !== 0) return false;
  if (incoming.exit !== 0) return true;
  if (!incoming.verify && winner.verify) return true;
  return false;
}

function completeness(row: HowTo): number {
  return row.files.length + (row.verify ? 1 : 0) + row.steps.length;
}

function uniqueId(rows: HowTo[], want?: string): string {
  const id = typeof want === "string" ? want.trim() : "";
  if (id && !rows.some((r) => r.id === id)) return id;
  let n = newId();
  while (rows.some((r) => r.id === n)) n = newId();
  return n;
}

function refreshRow(twin: HowTo, incoming: HowTo): HowTo {
  const out: HowTo = { ...twin, t: incoming.t };
  if (incoming.exit === 0) {
    out.exit = 0;
    out.wins = (twin.wins ?? (twin.exit === 0 ? 1 : 0)) + 1;
    if (incoming.cue) out.cue = incoming.cue;
    out.steps = incoming.steps;
    out.files = incoming.files;
    if (incoming.verify) out.verify = incoming.verify;
    else if (twin.verify) out.verify = twin.verify;
  }
  if (!out.family) out.family = twin.family || incoming.family || mintFamily(out);
  return out;
}

function applyPut(rows: HowTo[], incoming: HowTo): HowTo[] {
  const fp = fingerprint(incoming);
  const twinIdx = rows.findIndex((r) => fingerprint(r) === fp);
  if (twinIdx >= 0) {
    const twin = rows[twinIdx]!;
    if (incoming.exit !== 0 && twin.exit === 0) return rows;
    const next = rows.slice();
    next[twinIdx] = refreshRow(twin, incoming);
    return next;
  }

  const kin = rows.filter((r) => sameFamily(r, incoming));
  if (kin.length) {
    const familyId = kin.find((r) => r.family)?.family || mintFamily(kin[0]!) || mintFamily(incoming);
    const winner = kin.find((r) => r.exit === 0);
    const sibling: HowTo = {
      ...incoming,
      id: uniqueId(rows, incoming.id),
      family: familyId,
    };
    if (!(winner && isWorseThanWinner(incoming, winner)) && sibling.exit === 0 && sibling.wins === undefined) {
      sibling.wins = 1;
    }
    return [...rows, sibling];
  }

  const fresh: HowTo = {
    ...incoming,
    id: uniqueId(rows, incoming.id),
    family: incoming.family || mintFamily(incoming),
  };
  if (fresh.exit === 0 && fresh.wins === undefined) fresh.wins = 1;
  return [...rows, fresh];
}

function rankLatest(cue: string, a: HowTo, b: HowTo): number {
  const ov = overlapScore(cue, b) - overlapScore(cue, a);
  if (ov) return ov;
  const aOk = a.exit === 0 ? 1 : 0;
  const bOk = b.exit === 0 ? 1 : 0;
  if (bOk !== aOk) return bOk - aOk;
  const aWins = a.wins ?? 0;
  const bWins = b.wins ?? 0;
  if (bWins !== aWins) return bWins - aWins;
  const comp = completeness(b) - completeness(a);
  if (comp) return comp;
  return b.t - a.t;
}

export type HowToPruneOpts = {
  cwd?: string;
  exists?: (file: string) => boolean;
  now?: number;
  /** Child session: never drop exit===0 parent skills (child cwd may lack the parent's files). */
  child?: boolean;
};

export type HowToGap = {
  kind: "unknown";
  reason: string; // "missing place" / "missing selector" — NOT a command
  place?: string;
  after?: string;
  before?: string;
};

/** True if every candidate path is missing. Probe throw → present (fail-open). */
function namedFileGone(file: string, cwd: string, exists?: (file: string) => boolean): boolean {
  const probe = (p: string): boolean => {
    try {
      if (exists) return exists(p);
      return existsSync(p);
    } catch {
      return true;
    }
  };
  const name = String(file || "").trim();
  if (!name) return false;
  const candidates = isAbsolute(name) ? [name] : [cwd ? join(cwd, name) : "", name].filter(Boolean);
  return candidates.every((c) => !probe(c));
}

function shouldCheckFiles(dir: string, opts?: HowToPruneOpts): { check: boolean; cwd: string } {
  if (typeof opts?.exists === "function") {
    return { check: true, cwd: (typeof opts.cwd === "string" && opts.cwd.trim()) ? opts.cwd.trim() : dir };
  }
  const cwd = typeof opts?.cwd === "string" ? opts.cwd.trim() : "";
  if (cwd && cwd !== dir) return { check: true, cwd };
  return { check: false, cwd: dir };
}

/** Arg keys that name a place cell (file or selector). Not command/cmd. */
const PLACE_ARG_KEYS = ["path", "file", "filepath", "filename", "selector"] as const;

function isCommandLike(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/[|;&]/.test(t) || /\s(?:&&|\|\|)\s/.test(t)) return true;
  return /^(pytest|rm|cd)\s/i.test(t);
}

function asPlace(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s || isCommandLike(s)) return "";
  return s;
}

function stepPlaces(step: HowToStep): { place: string; selector: boolean }[] {
  const out: { place: string; selector: boolean }[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown, selector: boolean) => {
    const place = asPlace(raw);
    if (!place || seen.has(place)) return;
    seen.add(place);
    out.push({ place, selector });
  };
  for (const f of step.files ?? []) add(f, false);
  const args = step.args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const k of PLACE_ARG_KEYS) add(args[k], k === "selector");
  }
  return out;
}

function firstGonePlace(
  places: { place: string; selector: boolean }[],
  cwd: string,
  exists?: (file: string) => boolean,
): { place: string; selector: boolean } | null {
  for (const p of places) {
    if (namedFileGone(p.place, cwd, exists)) return p;
  }
  return null;
}

function neighborKeptName(
  steps: HowToStep[],
  stale: ReadonlyArray<{ place: string; selector: boolean } | null>,
  from: number,
  dir: -1 | 1,
): string | undefined {
  if (dir < 0) {
    for (let j = from - 1; j >= 0; j--) {
      if (stale[j]) continue;
      const n = typeof steps[j]?.name === "string" ? steps[j]!.name.trim() : "";
      if (n) return n;
    }
    return undefined;
  }
  for (let j = from + 1; j < steps.length; j++) {
    if (stale[j]) continue;
    const n = typeof steps[j]?.name === "string" ? steps[j]!.name.trim() : "";
    if (n) return n;
  }
  return undefined;
}

function unchangedHowToView(row: HowTo | null | undefined, gaps: HowToGap[] = []): { steps: HowToStep[]; files: string[]; gaps: HowToGap[] } {
  const steps = row && Array.isArray(row.steps) ? row.steps : [];
  const files = row && Array.isArray(row.files) ? row.files : [];
  return { steps, files, gaps };
}

/**
 * Omit steps whose place cells (files / selector-like args) are gone. Never invent a replacement path.
 * Retrieve/view-time only — not a second whole-row prune. Does not persist. Does not call pruneStale.
 */
export function omitStalePlace(row: HowTo, opts?: HowToPruneOpts): { steps: HowToStep[]; files: string[]; gaps: HowToGap[] } {
  try {
    const { check, cwd } = shouldCheckFiles("", opts);
    if (!check) return unchangedHowToView(row);
    const stepsIn = Array.isArray(row?.steps) ? row.steps : [];
    const filesIn = Array.isArray(row?.files) ? row.files : [];
    const exists = opts?.exists;
    const stale = stepsIn.map((s) => firstGonePlace(stepPlaces(s), cwd, exists));

    const kept: HowToStep[] = [];
    for (let i = 0; i < stepsIn.length; i++) {
      if (!stale[i]) kept.push(stepsIn[i]!);
    }

    const gaps: HowToGap[] = [];
    const covered = new Set<string>();
    for (let i = 0; i < stepsIn.length; i++) {
      const gone = stale[i];
      if (!gone) continue;
      const gap: HowToGap = {
        kind: "unknown",
        reason: gone.selector ? "missing selector" : "missing place",
        place: gone.place,
      };
      const after = neighborKeptName(stepsIn, stale, i, -1);
      const before = neighborKeptName(stepsIn, stale, i, 1);
      if (after) gap.after = after;
      if (before) gap.before = before;
      gaps.push(gap);
      covered.add(gone.place);
    }

    const files: string[] = [];
    for (const f of filesIn) {
      const name = typeof f === "string" ? f.trim() : "";
      if (!name) {
        if (typeof f === "string") files.push(f);
        continue;
      }
      if (namedFileGone(name, cwd, exists)) {
        if (!covered.has(name) && !isCommandLike(name)) {
          gaps.push({ kind: "unknown", reason: "missing place", place: name });
          covered.add(name);
        }
        continue;
      }
      files.push(f);
    }

    return { steps: kept, files, gaps };
  } catch {
    return unchangedHowToView(row);
  }
}

function pruneRows(rows: HowTo[], dir: string, opts?: HowToPruneOpts): HowTo[] {
  // Child prune never removes exit===0 rows. A child worktree can miss parent files.
  // exit!==0 rabbit holes still decay. Do not consult child cwd/exists for exit===0.
  const child = opts?.child === true;
  const { check, cwd } = shouldCheckFiles(dir, child ? undefined : opts);
  return rows.filter((r) => {
    if (r.exit !== 0) return false;
    if (child) return true;
    if (!check || !r.files.length) return true;
    for (const f of r.files) {
      if (namedFileGone(f, cwd, opts?.exists)) return false;
    }
    return true;
  });
}

function rowAfterPut(rows: HowTo[], incoming: HowTo): HowTo | undefined {
  const fp = fingerprint(incoming);
  return rows.find((r) => fingerprint(r) === fp) ?? rows.find((r) => r.id === incoming.id);
}

/** HowToStore: put(row); latest(cue, k). Never auto-promotes. Revisions, not LWW. */
export class HowToStore {
  readonly dir: string;
  readonly path: string;
  private readonly lockPath: string;

  constructor(dir: string) {
    let root = dir;
    try {
      root = resolveHowToDir(dir);
    } catch {
      root = dir;
    }
    this.dir = root;
    this.path = join(root, FILE);
    this.lockPath = `${this.path}.lock`;
    try {
      mkdirSync(root, { recursive: true });
      try { chmodSync(root, 0o700); } catch {}
    } catch {}
  }

  /**
   * Persist a how-to on the resolved memory root. Keeps a caller-supplied `id`
   * when it is unique; otherwise mints. Twin refresh keeps the existing id.
   * Returns the stored row so wrap-put and hook-retrieve share that id. Fail-open.
   */
  put(row: Omit<HowTo, "id"> & { id?: string }): HowTo | undefined {
    const cue = typeof row?.cue === "string" ? redactText(row.cue.trim()) : "";
    const steps = asSteps(row?.steps);
    const files = asFiles(row?.files);
    if (!cue && !steps.length && !files.length) return undefined;
    const t = Number(row?.t);
    const callerId = typeof row?.id === "string" ? row.id.trim() : "";
    const next: HowTo = {
      id: callerId || newId(),
      cue,
      steps,
      files,
      exit: typeof row?.exit === "number" && Number.isFinite(row.exit) ? row.exit : 0,
      t: Number.isFinite(t) ? t : Date.now(),
    };
    if (typeof row?.verify === "string") {
      const verify = redactText(row.verify.trim());
      if (verify) next.verify = verify;
    }
    const wins = asWins(row?.wins);
    if (wins !== undefined) next.wins = wins;
    if (typeof row?.family === "string") {
      const family = row.family.trim();
      if (family) next.family = family;
    }
    try {
      return withFileLock(this.lockPath, () => {
        const after = applyPut(load(this.path), next);
        persist(this.path, after);
        return rowAfterPut(after, next);
      });
    } catch {
      // Fail-open: lock/disk faults must not throw into inject/sleep.
      return undefined;
    }
  }

  latest(cue: string, k = 3): HowTo[] {
    try {
      const q = String(cue ?? "").trim();
      if (!q) return [];
      const cap = Math.max(0, Number(k) || 0);
      if (!cap) return [];
      return load(this.path)
        .sort((a, b) => rankLatest(q, a, b))
        .slice(0, cap);
    } catch {
      return [];
    }
  }

  /**
   * Highest persisted t / step.order. Sleep uses this so a later successful run
   * is not concatenated onto an earlier skill (M11.2 — no glued diverging tails).
   */
  watermark(): { t: number; order: number } {
    try {
      let t = 0;
      let order = -1;
      for (const row of load(this.path)) {
        const tt = Number(row.t);
        if (Number.isFinite(tt) && tt > t) t = tt;
        for (const s of row.steps ?? []) {
          if (typeof s.order === "number" && Number.isFinite(s.order) && s.order > order) {
            order = s.order;
          }
        }
      }
      return { t, order };
    } catch {
      return { t: 0, order: -1 };
    }
  }

  /**
   * Retrieve/view-time omit of stale place cells. Does not persist. Does not prune.
   * Pass project `cwd` or `exists`; without those, returns the row unchanged.
   */
  view(row: HowTo, opts?: HowToPruneOpts): { steps: HowToStep[]; files: string[]; gaps: HowToGap[] } {
    try {
      return omitStalePlace(row, opts);
    } catch {
      const steps = row && Array.isArray(row.steps) ? row.steps : [];
      const files = row && Array.isArray(row.files) ? row.files : [];
      return { steps, files, gaps: [] };
    }
  }

  /**
   * Sleep/idle only — never inject. Failed rabbit holes (`exit !== 0`) always decay.
   * `child: true` never drops `exit === 0` rows (parent skills stay even if the
   * child worktree is missing those files). Otherwise, missing named files drop
   * the row only when `exists` is passed or `cwd` is a project dir (not this store
   * dir), so sleep cannot wipe skills against ~/.eden/memory.
   */
  pruneStale(opts?: HowToPruneOpts): void {
    try {
      withFileLock(this.lockPath, () => {
        const rows = load(this.path);
        const keep = pruneRows(rows, this.dir, opts);
        if (keep.length !== rows.length) persist(this.path, keep);
      });
    } catch {
      // Fail-open: prune faults must not throw into sleep/inject.
    }
  }
}

/** Sleep/idle helper. Same rules as HowToStore.pruneStale. Never call from inject. */
export function pruneHowTo(dir: string, opts?: HowToPruneOpts): void {
  try {
    new HowToStore(dir).pruneStale(opts);
  } catch {}
}

/**
 * After a successful promote put: if two+ exit-0 kin share a step prefix of
 * length ≥ 2, put that prefix as one compressed how-to. Identical fingerprint
 * refreshes; full sibling approaches are not deleted. Fail-open.
 */
export function mergeSharedPrefixHowTo(dir: string): void {
  try {
    if (typeof dir !== "string" || !dir.trim()) return;
    const store = new HowToStore(dir);
    const rows = load(store.path).filter((r) => r.exit === 0);
    if (rows.length < 2) return;
    const planned = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const left = rows[i]!;
        const right = rows[j]!;
        if (!mergeKin(left, right)) continue;
        const merged = mergeSharedPrefix(left, right);
        if (!merged) continue;
        const fp = fingerprint(merged);
        if (planned.has(fp)) continue;
        planned.add(fp);
        store.put({
          cue: merged.cue,
          steps: merged.steps,
          files: merged.files,
          exit: 0,
          t: merged.t,
          ...(merged.verify ? { verify: merged.verify } : {}),
          ...(merged.family ? { family: merged.family } : {}),
        });
      }
    }
  } catch {
    // Fail-open: merge faults must not throw into consolidate/sleep.
  }
}
