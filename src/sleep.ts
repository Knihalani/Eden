import { chmodSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assemble,
  blockedKindOrLane,
  emitAssemblyTombstones,
  extractCandidates,
  losingTriples,
  type CandidateText,
  type Triple,
} from "./assemble";
import { isLiveRow, settlePendingRows, superseded, type MemoryRecord } from "./index";
import { memoryNow } from "./memory-clock";
import { inStoreOrder } from "./memory-ids";
import { ExperienceStore, promoteExperienceHowTo, type ExperienceState, type ExperienceTraj } from "./experience-store";
import { GistStore, scrubTombstonedIdentity } from "./gist-store";
import { promoteNarrativeGists } from "./gist-retrieve";
import { HowToStore, mergeSharedPrefixHowTo, type HowTo, type HowToStep } from "./howto-store";
import { memoryConsent } from "./memory-consent";
import { promotions } from "./memory-pins";
import { isUntyped } from "./memory-provenance";
import { opaqueId, scrubMemoryText } from "./memory-scrub";
import { noteSlots, slotLabel, typedValue } from "./memory-slots";
import { readInvalidations, validText, withoutExpiredIntents, type Invalidation } from "./memory-validity";
import { parseRuleTime, writeAliasTags, type MissClass } from "./memory-sota";
import {
  isIclExemplar,
  isRecsysShot,
  isToolProse,
  objectAsserted,
  SemanticStore,
  STATUS_OBJECT,
} from "./semantic-store";
import { loadToolTraces, memoryTracesDir, type ToolTrace } from "./tool-trace";

export { mergeSharedPrefix } from "./howto-store";

export type SleepRecord = Pick<
  MemoryRecord,
  "id" | "text" | "kind" | "at" | "seq" | "lane" | "tags" | "scope" | "slots" | "rules"
> & {
  sal?: number;
  ep?: string;
  heat?: number;
  validUntil?: number;
  validFrom?: number;
  invalidAt?: number;
  invalidBy?: string;
};
export type SleepMem = {
  dir: string;
  /** Directory of memories.jsonl / traces.jsonl (session subdir when session is set). */
  jsonlDir?: string;
  /** How-to jsonl directory: always the memory root, never jsonlDir / session subdir. */
  howtoDir?: string;
  /** Set by hook/wrap. A `--` in the session name is not enough. */
  child?: boolean;
  /** A store in a format this code does not know: sleep writes nothing to it (EXECUTION §9). */
  sealed?: boolean;
  memories(): SleepRecord[];
  dropWhere?(pred: (r: MemoryRecord) => boolean): void;
  rewriteWhere?(fn: (r: MemoryRecord) => string | undefined): void;
  patchWhere?(fn: (r: MemoryRecord) => MemoryRecord | undefined): void;
};

/** HowToStore lives on the constructor root (like semantic/gists), never beside session memories.jsonl. */
function howtoRoot(mem: SleepMem): string {
  const pinned = typeof mem.howtoDir === "string" ? mem.howtoDir.trim() : "";
  return pinned || mem.dir;
}

function samePath(a: string, b: string): boolean {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return a === b;
  }
}

function asLeftoverHowTo(v: unknown): (Omit<HowTo, "id"> & { id?: string }) | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const cue = typeof o.cue === "string" ? o.cue : "";
  const steps = Array.isArray(o.steps) ? (o.steps as HowToStep[]) : [];
  const files = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === "string") : [];
  if (!cue && !steps.length && !files.length) return null;
  const t = Number(o.t);
  const row: Omit<HowTo, "id"> & { id?: string } = {
    cue,
    steps,
    files,
    exit: typeof o.exit === "number" && Number.isFinite(o.exit) ? o.exit : 0,
    t: Number.isFinite(t) ? t : Date.now(),
  };
  if (typeof o.id === "string" && o.id.trim()) row.id = o.id.trim();
  if (typeof o.verify === "string") row.verify = o.verify;
  if (typeof o.wins === "number" && Number.isFinite(o.wins)) row.wins = o.wins;
  if (typeof o.family === "string") row.family = o.family;
  return row;
}

function leftoverHowToPath(dir: string): string {
  return join(dir, "howto.jsonl");
}

function leftoverHowToFiles(mem: SleepMem, root: string): string[] {
  const out: string[] = [];
  const rootFile = leftoverHowToPath(root);
  const add = (p: string) => {
    if (!p || samePath(p, rootFile) || out.some((x) => samePath(x, p))) return;
    try {
      if (existsSync(p)) out.push(p);
    } catch {}
  };
  try {
    const jsonlDir = typeof mem.jsonlDir === "string" ? mem.jsonlDir : "";
    if (jsonlDir && !samePath(jsonlDir, root)) add(leftoverHowToPath(jsonlDir));
  } catch {}
  try {
    // Wrap has no session (jsonlDir === root); still heal memory/<session>/howto.jsonl leftovers.
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      add(leftoverHowToPath(join(root, ent.name)));
    }
  } catch {}
  return out;
}

function retireLeftoverHowTo(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    try {
      writeFileSync(path, "");
    } catch {}
  }
  try {
    unlinkSync(`${path}.lock`);
  } catch {}
}

/**
 * Merge leftover `memory/<session>/howto.jsonl` onto the memory root, then stop using the session file.
 * Fail-open: parse/put/unlink must not throw into sleep or inject.
 */
export function migrateSessionHowTo(mem: SleepMem): void {
  try {
    const root = howtoRoot(mem);
    if (!root) return;
    const leftovers = leftoverHowToFiles(mem, root);
    if (!leftovers.length) return;
    const dest = new HowToStore(root);
    for (const leftover of leftovers) {
      try {
        const body = readFileSync(leftover, "utf8");
        for (const line of body.split("\n")) {
          if (!line) continue;
          try {
            const row = asLeftoverHowTo(JSON.parse(line));
            if (row) dest.put(row);
          } catch {}
        }
        retireLeftoverHowTo(leftover);
      } catch {}
    }
  } catch {}
}

function isIcl(text: string): boolean {
  return isIclExemplar(text);
}

function normObj(o: string): string {
  return o
    .replace(/[.,;:!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function identitySentence(s: string, p: string, o: string): string {
  return p === "uses" ? `Use ${o}.` : `The ${s} is ${o}.`;
}

function liveKey(s: string, p: string): string {
  return `${s}\0${p}`;
}

function recLane(r: { lane?: unknown }): string | undefined {
  return typeof r.lane === "string" && r.lane.trim() ? r.lane : undefined;
}

/**
 * Identity extract (assemble extractCandidates) at the row's time `at`. ICL / tool prose / narrative lanes yield
 * nothing, and are skipped before any text test: a narrative row can be tens of KB. So does a row the user did not
 * type (A4 §3.0: an episode, never a slot fact). Fail-open: a bad episode returns [] so consolidate continues.
 */
function extractIdentity(r: {
  id?: string;
  text?: string;
  at?: number;
  kind?: string;
  lane?: string;
  tags?: string[];
}): Triple[] {
  try {
    const text = String(r?.text ?? "");
    if (!text || isUntyped(r) || blockedKindOrLane(r) || isIcl(text) || isToolProse(text) || isRecsysShot(text))
      return [];
    const tags = Array.isArray(r.tags) ? r.tags : [];
    if (tags.some((t) => String(t).toLowerCase() === "recsys")) return [];
    const c: CandidateText = { text, t: Number.isFinite(r.at) ? Number(r.at) : 0 };
    if (r.id != null && r.id !== "") c.id = r.id;
    if (r.kind) c.kind = r.kind;
    const lane = recLane(r);
    if (lane) c.lane = lane;
    return extractCandidates([c]);
  } catch {
    return [];
  }
}

const READ_TOOL = /^(read|grep|glob|ls|websearch|semanticsearch|cat|head|tail)$/i;
const SHELL_TOOL = /^(bash|shell|terminal|zsh|sh)$/i;
const MUTATE_TOOL = /^(write|edit|strreplace)$/i;
const VERIFY_CMD = /\b(?:pytest|vitest|jest|mocha)\b|\b(?:bun|cargo|go)\s+test\b|\bnpm\s+(?:run\s+)?test\b/i;
const READ_BASH = new RegExp(
  String.raw`^(?:git\s+(?:log|status|show|diff|blame|grep)|ls|cat|head|tail|grep|egrep|fgrep|rg|find|` +
    String.raw`echo|pwd|which|type|wc|file|stat)\b`,
  "i",
);

function jsonHay(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function commandHay(tr: ToolTrace): string {
  const args = tr.args ?? {};
  const parts: string[] = [];
  for (const k of ["command", "cmd", "script"] as const) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) parts.push(v);
  }
  if (!parts.length) {
    const hay = jsonHay(args);
    if (hay && hay !== "{}") parts.push(hay);
  }
  return parts.join(" ");
}

function traceBlob(tr: ToolTrace): string {
  return `${tr.name} ${commandHay(tr)} ${jsonHay(tr.args ?? {})}`;
}

function traceIsIcl(tr: ToolTrace): boolean {
  return isIclExemplar(commandHay(tr)) || isIclExemplar(traceBlob(tr));
}

function isReadOnlyCommand(cmd: string): boolean {
  const parts = cmd
    .split(/(?:&&|\|\||[;\n|])/)
    .map((p) => p.trim().replace(/^\(\s*/, ""))
    .filter(Boolean);
  if (!parts.length) return true;
  return parts.every((p) => READ_BASH.test(p.replace(/^sudo\s+/i, "")));
}

function isReadOnlyTrace(tr: ToolTrace): boolean {
  const name = String(tr.name || "").trim();
  if (READ_TOOL.test(name)) return true;
  if (SHELL_TOOL.test(name)) return isReadOnlyCommand(commandHay(tr));
  return false;
}

function isMutatingTrace(tr: ToolTrace): boolean {
  const name = String(tr.name || "").trim();
  if (MUTATE_TOOL.test(name)) return true;
  if (SHELL_TOOL.test(name)) return !isReadOnlyCommand(commandHay(tr));
  return false;
}

function isVerifyLike(tr: ToolTrace): boolean {
  return VERIFY_CMD.test(commandHay(tr));
}

function verifyCommand(tr: ToolTrace): string | undefined {
  const args = tr.args ?? {};
  for (const k of ["command", "cmd", "script"] as const) {
    const v = args[k];
    if (typeof v === "string" && v.trim() && VERIFY_CMD.test(v)) return v.trim();
  }
  const hay = commandHay(tr).trim();
  return hay && VERIFY_CMD.test(hay) ? hay : undefined;
}

function traceKey(tr: ToolTrace): string {
  return `${tr.order}\0${tr.name}\0${jsonHay(tr.args)}\0${tr.t}`;
}

function loadHowToTraces(mem: SleepMem, session?: string): ToolTrace[] {
  try {
    const dirs: string[] = [];
    const add = (d?: string) => {
      if (typeof d === "string" && d && !dirs.includes(d)) dirs.push(d);
    };
    add(mem.jsonlDir);
    add(mem.dir);
    add(memoryTracesDir(mem.dir, session));
    const out: ToolTrace[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      for (const row of loadToolTraces(dir)) {
        const key = traceKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(row);
      }
    }
    out.sort((a, b) => a.order - b.order || a.t - b.t);
    return out;
  } catch {
    return [];
  }
}

/** Drop traces already compressed into a how-to. A later run must not glue onto the last skill. */
function tracesAfterHowTo(traces: ToolTrace[], mem: SleepMem): ToolTrace[] {
  try {
    const cut = new HowToStore(howtoRoot(mem)).watermark();
    if (cut.t <= 0 && cut.order < 0) return traces;
    return traces.filter((tr) => tr.t > cut.t || tr.order > cut.order);
  } catch {
    return traces;
  }
}

function blockingFailedVerify(traces: ToolTrace[]): boolean {
  for (let i = 0; i < traces.length; i++) {
    const tr = traces[i]!;
    if (!isVerifyLike(tr) || typeof tr.exit !== "number" || tr.exit === 0) continue;
    const laterPass = traces.slice(i + 1).some((t) => isVerifyLike(t) && t.exit === 0);
    if (!laterPass) return true;
  }
  return false;
}

function lastNonIclEpisode(recs: SleepRecord[]): string {
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i]!;
    const text = String(r.text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || r.kind === "constraint" || isIcl(text) || isToolProse(text)) continue;
    return text.slice(0, 400);
  }
  return "";
}

function toHowToStep(tr: ToolTrace): HowToStep {
  const step: HowToStep = { name: String(tr.name || "").trim() || "subagent" };
  if (tr.args && typeof tr.args === "object" && !Array.isArray(tr.args)) step.args = tr.args;
  if (tr.files?.length) step.files = tr.files.filter((f) => typeof f === "string" && f.trim());
  if (typeof tr.exit === "number" && Number.isFinite(tr.exit)) step.exit = tr.exit;
  if (typeof tr.order === "number" && Number.isFinite(tr.order)) step.order = tr.order;
  return step;
}

function unionFiles(steps: HowToStep[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    for (const f of s.files ?? []) {
      const t = f.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function howToCue(files: string[], verify: string | undefined, episode: string): string {
  return [files.join(" "), verify ?? "", episode].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 800);
}

/** Hook/wrap set `mem.child`. A parent id containing `--` is not a child. */
function memIsChild(mem: SleepMem): boolean {
  try {
    return mem.child === true;
  } catch {
    return false;
  }
}

function sleepSession(mem: SleepMem, opts?: { session?: string }): string | undefined {
  try {
    const fromOpts = typeof opts?.session === "string" ? opts.session.trim() : "";
    if (fromOpts) return fromOpts;
    const raw = (mem as { session?: unknown }).session;
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compress a successful tool run into HowToStore. Dead ends stay in traces.jsonl.
 * Fail-open: callers wrap consolidate; this lane also swallows so gist/tombstones survive.
 */
function promoteHowTo(mem: SleepMem, recs: SleepRecord[], session?: string): void {
  try {
    try {
      migrateSessionHowTo(mem);
    } catch {}
    const root = howtoRoot(mem);
    const loaded = loadHowToTraces(mem, session);
    if (!loaded.length) return;
    if (loaded.every(traceIsIcl)) return;
    const traces = tracesAfterHowTo(
      loaded.filter((t) => !traceIsIcl(t)),
      mem,
    );
    if (!traces.length) return;
    if (traces.every(isReadOnlyTrace)) return;
    if (blockingFailedVerify(traces)) return;
    const okVerify = traces.some((t) => isVerifyLike(t) && t.exit === 0);
    // Child with no exit-0 verify must not put (would risk replacing a parent skill). Do not prune here.
    if (memIsChild(mem) && !okVerify) return;
    const okMutate = traces.some((t) => isMutatingTrace(t) && t.exit === 0);
    if (!okVerify && !okMutate) return;
    const surviving = traces.filter((t) => typeof t.exit !== "number" || t.exit === 0);
    const steps = surviving.map(toHowToStep).filter((s) => s.name);
    if (!steps.length) return;
    const files = unionFiles(steps);
    let verify: string | undefined;
    for (let i = surviving.length - 1; i >= 0; i--) {
      if (surviving[i]!.exit !== 0 && surviving[i]!.exit !== undefined) continue;
      const cmd = verifyCommand(surviving[i]!);
      if (cmd) {
        verify = cmd;
        break;
      }
    }
    if (!verify) {
      for (let i = traces.length - 1; i >= 0; i--) {
        if (traces[i]!.exit !== 0) continue;
        const cmd = verifyCommand(traces[i]!);
        if (cmd) {
          verify = cmd;
          break;
        }
      }
    }
    const t = surviving.reduce((m, tr) => (tr.t > m ? tr.t : m), 0) || Date.now();
    const cue = howToCue(files, verify, lastNonIclEpisode(recs));
    try {
      new HowToStore(root).put({ cue, steps, files, ...(verify ? { verify } : {}), exit: 0, t });
      try {
        mergeSharedPrefixHowTo(root);
      } catch {
        // Fail-open: merge must not undo the put or throw out of consolidate/sleep.
      }
    } catch {}
  } catch {}
}

const EXPERIENCE_GIST_CAP = 800;

/** LWW key distinct from the fact/pin session so Clerk/sqlite gists are not replaced. */
function experienceGistSession(trajId: string): string {
  return `exp:${trajId}`;
}

function extraStr(obj: unknown, key: string): string {
  try {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v).trim();
    return "";
  } catch {
    return "";
  }
}

function lastExtra(traj: ExperienceTraj, key: "goal" | "outcome"): string {
  let fromState = "";
  for (const st of traj.states) {
    const s = extraStr(st, key);
    if (s) fromState = s;
  }
  return fromState || extraStr(traj, key);
}

function fallbackGistParts(states: ExperienceState[]): string[] {
  for (let i = states.length - 1; i >= 0; i--) {
    const st = states[i]!;
    const parts = [st.thought, st.action, st.url]
      .map((s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : ""))
      .filter(Boolean);
    if (parts.length) return parts;
  }
  return [];
}

function experienceGistText(traj: ExperienceTraj): { text: string; t: number } {
  const goal = lastExtra(traj, "goal");
  const outcome = lastExtra(traj, "outcome");
  const parts = goal || outcome ? [goal, outcome].filter(Boolean) : fallbackGistParts(traj.states);
  let t = 0;
  for (const st of traj.states) {
    if (typeof st.t === "number" && Number.isFinite(st.t) && st.t > t) t = st.t;
  }
  return { text: parts.join(". ").replace(/\s+/g, " ").trim().slice(0, EXPERIENCE_GIST_CAP), t: t || Date.now() };
}

/**
 * Named HowToStore mint (exit 0 + verify). Fail-open: a throw must not abort
 * gists, tombstones, or inject. Do not namespace-probe — a miss is a silent no-op.
 */
function promoteExperienceHowToSafe(root: string, traj: ExperienceTraj): void {
  try {
    promoteExperienceHowTo(root, traj);
  } catch {}
}

/**
 * Replay ExperienceStore files into gists. Hippocampus stays: never unlink / rewrite / empty traj jsonl.
 * Chat-only (missing dir / empty ids) is a no-op — does not mkdir experience/ or mint how-to.
 * Fail-open: one corrupt file must not abort tombstones, fact gists, or inject.
 */
function replayExperience(mem: SleepMem): void {
  try {
    const root = typeof mem.dir === "string" ? mem.dir : "";
    if (!root) return;
    const store = new ExperienceStore(root);
    const ids = store.ids();
    if (!ids.length) return;
    const gists = new GistStore(root);
    const howto = howtoRoot(mem);
    for (const id of ids) {
      try {
        const traj = store.get(id);
        if (!traj || !Array.isArray(traj.states) || !traj.states.length) continue;
        const built = experienceGistText(traj);
        let text = built.text;
        try {
          text = scrubTombstonedIdentity(text, root);
        } catch {}
        if (text) {
          try {
            gists.put(text, experienceGistSession(id), built.t, "experience");
          } catch {}
        }
        try {
          promoteExperienceHowToSafe(howto, traj);
        } catch {}
      } catch {
        // Fail-open: one corrupt traj must not abort the rest of the pass.
      }
    }
  } catch {
    // Fail-open: the whole experience lane must not undo tombstones/gists or throw into inject.
  }
}

/**
 * Sync replay: serial-aware extract → code max(t) per (s,p) → SemanticStore tombstone/put,
 * superseded episode texts dropped from JSONL, gist of winners. How-to / gist / migrate stay.
 * Throws stay inside the caller’s try/catch (sleep / hook / AgentMemory.sleep).
 */
function isSalient(r: SleepRecord): boolean {
  const t = String(r.text ?? "");
  const tags = (r.tags ?? []).map((x) => String(x).toLowerCase());
  if (tags.includes("pin") || r.kind === "constraint") return true;
  if (/\b(?:actually|correction|instead of|rather than|not\s+\w+\s+anymore)\b/i.test(t)) return true;
  if (/\b(?:was failing|now passing|test(?:s)?\s+(?:pass|fail|flipped|flip))\b/i.test(t)) return true;
  if (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(t)) return true;
  if (/\bexit\s+[1-9]\d*\b/i.test(t) || /\bnon-?zero exit\b/i.test(t)) return true;
  return false;
}

function oSame(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Fast-memorize: pins + identity copulas → SemanticStore.
 * Same value → NOOP. Change → tombstone + insert. Local (s,p) only.
 */
function fastMemorize(mem: SleepMem, recs: SleepRecord[]): void {
  try {
    const root = typeof mem.dir === "string" ? mem.dir : "";
    if (!root) return;
    const store = new SemanticStore(root);
    store.beginBatch();
    try {
      const ordered = [...recs.filter(isSalient), ...recs.filter((r) => !isSalient(r))];
      const seen = new Set<string>();
      for (const r of ordered) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        // The semantic store has no scope: a row whose place is known never puts there (A4 §3.2, `remember`).
        if (r.scope !== undefined) continue;
        const pin = r.kind === "constraint" || (r.tags ?? []).some((t) => String(t).toLowerCase() === "pin");
        let facts: Triple[] = [];
        try {
          facts = extractIdentity(r);
        } catch {
          facts = [];
        }
        if (!pin && !facts.length) continue;
        for (const fact of facts) {
          const live = store.get(fact.s, fact.p);
          if (live && oSame(live.o, fact.o)) continue;
          const t = Number.isFinite(fact.t) && fact.t > 0 ? fact.t : r.at || memoryNow();
          if (live && !oSame(live.o, fact.o)) store.tombstone(fact.s, fact.p, t);
          store.put(fact.s, fact.p, fact.o, t);
        }
      }
    } finally {
      try {
        store.endBatch();
      } catch {}
    }
  } catch {}
}

function stampForesight(mem: SleepMem, recs: SleepRecord[]): void {
  try {
    if (!mem.patchWhere) return;
    const byId = new Map(recs.map((r) => [r.id, r]));
    mem.patchWhere((row) => {
      const r = byId.get(row.id) ?? row;
      const parsed = parseRuleTime(String(r.text ?? ""));
      if (!parsed?.until) return;
      if (row.validUntil === parsed.until) return;
      return { ...row, validUntil: parsed.until };
    });
  } catch {}
}

function decayHeat(mem: SleepMem, recs: SleepRecord[]): void {
  try {
    if (!mem.patchWhere) return;
    const root = typeof mem.dir === "string" ? mem.dir : "";
    if (!root) return;
    const live = new SemanticStore(root).live();
    const prov = new Map<string, number>();
    for (const r of recs) {
      if (superseded(r)) continue;
      let facts: Triple[] = [];
      try {
        facts = extractIdentity(r);
      } catch {
        facts = [];
      }
      for (const f of facts) {
        if (!live.some((l) => l.s === f.s && l.p === f.p && oSame(l.o, f.o))) continue;
        const k = `${f.s}\0${f.p}\0${normObj(f.o)}`;
        prov.set(k, (prov.get(k) ?? 0) + 1);
      }
    }
    mem.patchWhere((row) => {
      if (superseded(row)) return;
      let facts: Triple[] = [];
      try {
        facts = extractIdentity(row);
      } catch {
        facts = [];
      }
      const sole = facts.some((f) => {
        const k = `${f.s}\0${f.p}\0${normObj(f.o)}`;
        return (prov.get(k) ?? 0) === 1 && live.some((l) => l.s === f.s && l.p === f.p && oSame(l.o, f.o));
      });
      if (sole) return;
      const unusedEpisode = row.kind === "episode";
      const failedProc = row.kind === "procedure" && /\b(?:fail|exit\s+[1-9])\b/i.test(row.text);
      if (!unusedEpisode && !failedProc) return;
      const heat = Math.max(
        0,
        (typeof row.heat === "number" ? row.heat : typeof row.sal === "number" ? row.sal : 1) * 0.5,
      );
      if (row.heat === heat && row.sal === heat) return;
      return { ...row, heat, sal: heat };
    });
  } catch {}
}

function healWriteAliases(mem: SleepMem): void {
  try {
    if (!mem.patchWhere) return;
    mem.patchWhere((row) => {
      const next = writeAliasTags(row.tags ?? [], row.text);
      const prev = row.tags ?? [];
      if (next.length === prev.length && next.every((t) => prev.includes(t))) return;
      return { ...row, tags: next };
    });
  } catch {}
}

function writeSleepPostings(mem: SleepMem, recs: SleepRecord[]): void {
  try {
    const dir = typeof mem.jsonlDir === "string" && mem.jsonlDir ? mem.jsonlDir : mem.dir;
    if (!dir) return;
    const map = new Map<string, string[]>();
    for (const r of recs) {
      for (const t of writeAliasTags(r.tags ?? [], r.text)) {
        if (t.length < 3) continue;
        let arr = map.get(t);
        if (!arr) map.set(t, (arr = []));
        if (!arr.includes(r.id)) arr.push(r.id);
      }
    }
    if (!map.size) return;
    const path = join(dir, "sleep-postings.jsonl");
    writeFileSync(path, [...map.entries()].map(([t, ids]) => JSON.stringify({ t, ids })).join("\n") + "\n");
    try {
      chmodSync(path, 0o600);
    } catch {}
  } catch {}
}

function writeMissTaxonomy(dir: string, recs: SleepRecord[]): void {
  try {
    if (!dir) return;
    let live: { s: string; p: string; o: string }[] = [];
    try {
      live = new SemanticStore(dir).live();
    } catch {
      live = [];
    }
    const rows: { id: string; miss: MissClass }[] = [];
    for (const r of recs) {
      const text = String(r.text ?? "");
      if (!text) continue;
      let fact: ReturnType<typeof objectAsserted>;
      try {
        fact = objectAsserted(text);
      } catch {
        fact = undefined;
      }
      let extracted: Triple[] = [];
      try {
        extracted = extractIdentity(r);
      } catch {
        extracted = [];
      }
      if (/\b(?:is|are|uses)\b/i.test(text) && !fact && !extracted.length && !isIcl(text)) {
        rows.push({ id: r.id, miss: "Encode" });
      } else if (
        extracted.length &&
        extracted.every((f) => !live.some((l) => l.s === f.s && l.p === f.p && oSame(l.o, f.o)))
      ) {
        rows.push({ id: r.id, miss: "Store" });
      } else if (superseded(r)) {
        rows.push({ id: r.id, miss: "Maintain" });
      } else if ((r.kind === "episode" || r.kind === "procedure") && (r.heat ?? r.sal ?? 1) < 0.6) {
        rows.push({ id: r.id, miss: "Retrieve" });
      }
    }
    if (!rows.length) return;
    const path = join(dir, "miss.jsonl");
    writeFileSync(path, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    try {
      chmodSync(path, 0o600);
    } catch {}
  } catch {}
}

function applyMissTaxonomy(mem: SleepMem, recs: SleepRecord[]): void {
  try {
    const dir = typeof mem.dir === "string" ? mem.dir : "";
    if (!dir) return;
    const path = join(dir, "miss.jsonl");
    if (!existsSync(path)) return;
    const rows: { id?: string; miss?: string }[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      try {
        rows.push(JSON.parse(line) as { id?: string; miss?: string });
      } catch {}
    }
    if (!rows.length) return;
    const byId = new Map(recs.map((r) => [r.id, r]));
    const store = new SemanticStore(dir);
    for (const row of rows) {
      const miss = String(row.miss ?? "");
      if (miss === "Maintain") continue;
      const rec = byId.get(String(row.id ?? ""));
      if (!rec || isUntyped(rec)) continue;
      if (miss === "Store" || miss === "Encode") {
        let facts: Triple[] = [];
        try {
          facts = extractIdentity(rec);
        } catch {
          facts = [];
        }
        if (!facts.length) {
          const text = String(rec.text ?? "");
          const use = text.match(/^(?:the\s+)?([A-Za-z][\w.-]{1,40})\s+uses\s+(\S.+)$/i);
          const cop = use ?? text.match(/^(?:the\s+)?(.{1,80}?)\s+(?:is|are)\s+(\S.+)$/i);
          if (cop) {
            const s = cop[1]!
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, " ")
              .trim();
            const o = cop[2]!.replace(/[.,;:!?]+$/g, "").trim();
            const p = use ? "uses" : "is";
            if (s && o && !STATUS_OBJECT.test(o) && !/\b(?:instead of|rather than)\b/i.test(o)) {
              try {
                const live = store.get(s, p);
                if (
                  !(live && live.o.trim().toLowerCase() !== o.trim().toLowerCase()) &&
                  !store.supersededObject(o, s, p)
                ) {
                  store.put(s, p, o, Number(rec.at) || memoryNow());
                }
              } catch {}
            }
          }
        }
        for (const f of facts) {
          try {
            if (STATUS_OBJECT.test(f.o)) continue;
            if (/\b(?:instead of|rather than)\b/i.test(f.o)) continue;
            const live = store.get(f.s, f.p);
            if (live && live.o.trim().toLowerCase() !== f.o.trim().toLowerCase()) continue;
            if (store.supersededObject(f.o, f.s, f.p)) continue;
            store.put(f.s, f.p, f.o, Number.isFinite(f.t) ? f.t : Number(rec.at) || memoryNow());
          } catch {}
        }
      }
      if ((miss === "Encode" || miss === "Retrieve") && mem.patchWhere) {
        mem.patchWhere((r) => {
          if (r.id !== rec.id) return;
          const next = writeAliasTags(r.tags ?? [], r.text);
          const prev = r.tags ?? [];
          if (next.length === prev.length && next.every((t) => prev.includes(t))) return;
          return { ...r, tags: next };
        });
      }
    }
  } catch {}
}

export type SleepMode = "full" | "incremental";
export type ConsolidateOpts = {
  session?: string;
  goal?: string;
  /** Default "full" (tombstones allowed). "incremental" gists only; open-goal facts stay in JSONL. */
  mode?: SleepMode;
  /** Epoch ms. Incremental pass aborts remaining lanes once this has passed. Full Stop/idle ignores it. */
  deadline?: number;
};

/** True only for a time-capped incremental pass whose deadline has passed. */
function incrementalExpired(opts?: ConsolidateOpts): boolean {
  if (opts?.mode !== "incremental") return false;
  const deadline = opts.deadline;
  if (typeof deadline !== "number" || !Number.isFinite(deadline)) return false;
  return Date.now() >= deadline;
}

/**
 * Whether a row is the slept session's own (its `ep`), as its gist states only what it said: a repo's store (D1)
 * holds every session's rows. A row with no `ep`, or a sleep naming no session, counts as its own.
 */
function ownRows(mem: SleepMem, session: string | undefined): (id: string) => boolean {
  const ep = session?.trim() ? opaqueId(session.trim()) : undefined;
  if (!ep) return () => true;
  const eps = new Map(mem.memories().map((r) => [r.id, r.ep]));
  return (id) => {
    const rowEp = eps.get(id);
    return !rowEp || rowEp === ep;
  };
}

/** The store's live rows in store order: a superseded row is history (A4 §3.1), neither a candidate nor a loser. */
function liveInStoreOrder(mem: SleepMem): { row: SleepRecord; t: number }[] {
  return inStoreOrder(mem.memories().filter((r) => !superseded(r)));
}

/** Each live row's identity candidates, at its own time. */
function identityCandidates(ordered: readonly { row: SleepRecord; t: number }[]): Triple[] {
  const candidates: Triple[] = [];
  for (const { row, t } of ordered) {
    try {
      for (const fact of extractIdentity({ ...row, at: t })) candidates.push(fact);
    } catch {
      // Fail-open: a bad episode must not abort the rest of the sleep.
    }
  }
  return candidates;
}

/** An intent row (D9): it expires after 7 days, so a gist, which outlives it, never carries it. */
function isIntent(r: MemoryRecord): boolean {
  return !!r.rules?.length && r.rules.every((rule) => rule.q);
}

/**
 * The session's slot values (D7): each `(scope, slot)`'s newest live value the session set, as its row types it, in
 * a sentence the slot table reads back ("In packages/cli the database is sqlite").
 */
function slotFacts(mem: SleepMem, own: (id: string) => boolean, invalid: readonly Invalidation[]): string[] {
  const newest = new Map<string, { text: string; at: number; scope: string | undefined }>();
  const rows = mem.memories().filter((row) => !superseded(row) && !isUntyped(row));
  for (const row of [...rows].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)))
    for (const ref of noteSlots(row)) {
      if (ref.v === undefined) continue;
      const subject = `${row.scope ? `In ${row.scope} the` : "The"} ${slotLabel(ref.k)}`;
      const text = `${subject} is ${typedValue(row.text, ref.k, ref.v)}`;
      const fact = own(row.id) ? { text, at: row.at ?? 0, scope: row.scope } : { text: "", at: 0, scope: row.scope };
      newest.set(`${row.scope ?? ""}\0${ref.k}`, fact);
    }
  return [...newest.values()].flatMap(({ text, at, scope }) => {
    const fact = text && validText(text, at, invalid, scope);
    return fact ? [fact] : [];
  });
}

/**
 * The session gist: the winning value of each subject the session stated, its slots' values, then its pins. A4
 * §3.3, §5.1 step 5: it is rewritten at every sleep, later than what it states, so each source is checked against
 * the validity log at its own time; SessionStart checks the gist again at the gist's time.
 */
function writeSessionGist(mem: SleepMem, winners: readonly Triple[], session: string | undefined): void {
  const invalid = readInvalidations(mem.dir);
  const own = ownRows(mem, session);
  // A slot row's value is stated by its scope (`slotFacts`): the winners are the store's, across scopes.
  const keyed = new Set(mem.memories().flatMap((row) => (noteSlots(row).length ? [row.id] : [])));
  const facts: string[] = [];
  for (const w of winners) {
    if ((w.recId && !own(w.recId)) || (w.recId && keyed.has(w.recId))) continue;
    const fact = validText(w.p === "uses" ? `${w.s} uses ${w.o}` : `${w.s} is ${w.o}`, w.t, invalid);
    if (fact) facts.push(fact);
  }
  facts.push(...slotFacts(mem, own, invalid));
  const pins = mem
    .memories()
    .filter((r) => r.kind === "constraint" && !superseded(r) && !isIntent(r) && !isIcl(r.text) && own(r.id))
    .slice(-8)
    .map((r) => validText(withoutExpiredIntents(r.text.replace(/\s+/g, " ").trim(), r.at), r.at, invalid, r.scope))
    .filter(Boolean);
  const gist = [...facts, ...pins].join(". ").slice(0, 800);
  if (gist) new GistStore(mem.dir).put(gist, session?.trim() ? session.trim() : "default", memoryNow());
}

/**
 * Light sleep (D34, A4 §6), at `stop-sleep` and SessionEnd: pending rows get their `seq`, the session gist is
 * rewritten, and the turn's verified tool run becomes a how-to, so the next turn's cue can retrieve both. Its cost is
 * one pass over the live rows' identity statements and the tool traces since the last how-to; every pass that
 * rewrites or rescans the store (narrative gists, aliases, postings, the miss taxonomy) is the idle sleeper's.
 */
export function lightSleep(mem: SleepMem, session: string | undefined): void {
  try {
    if (memoryConsent() !== "on" || mem.sealed) return;
  } catch {
    return;
  }
  try {
    settlePendingRows(mem.dir);
  } catch {}
  const ordered = liveInStoreOrder(mem);
  try {
    writeSessionGist(mem, assemble(identityCandidates(ordered)), session);
  } catch {}
  promoteHowTo(
    mem,
    ordered.map(({ row }) => row),
    sleepSession(mem, { session }),
  );
}

/** D9's promotion (A4 §6, §7 `recurring_policy`): a policy said in 2 sessions is a pin (`memory-pins.ts`). */
function promotePolicies(mem: SleepMem): void {
  if (!mem.patchWhere) return;
  const live = (mem.memories() as MemoryRecord[]).filter((row) => row.rules?.length && isLiveRow(row));
  const promoted = promotions(live, readInvalidations(mem.dir));
  if (!promoted.size) return;
  mem.patchWhere((row) => {
    const rules = promoted.get(row.id);
    return rules ? { ...row, rules } : undefined;
  });
}

/**
 * The rows whose values compete (A4 §3.2: a value supersedes only at its own scope): each scope's rows, with the rows
 * of unknown scope (written before P3.2 placed rows), which compete with every scope's as all rows did. A store with
 * no placed row is one group.
 */
function scopeGroups<T extends { row: SleepRecord }>(ordered: readonly T[]): T[][] {
  const scopes = [...new Set(ordered.flatMap(({ row }) => (typeof row.scope === "string" ? [row.scope] : [])))];
  if (!scopes.length) return [[...ordered]];
  return scopes.map((scope) => ordered.filter(({ row }) => row.scope === undefined || row.scope === scope));
}

/** Triples once each: a row of unknown scope wins in every group it is in. */
function distinctTriples(triples: readonly Triple[]): Triple[] {
  const seen = new Set<string>();
  return triples.filter((tr) => {
    const key = `${liveKey(tr.s, tr.p)}\0${normObj(tr.o)}\0${tr.recId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One group's assembly (`scopeGroups`): each fact row whose every value lost, superseded by the row that won, and
 * each "instead of" row said again as its subject's winning value. A row already given its successor or rewrite by
 * another group keeps it.
 */
function supersedeLosers(
  group: { recs: readonly SleepRecord[]; candidates: Triple[]; winners: Triple[] },
  supersededBy: Map<string, string>,
  rewrites: Map<string, string>,
): void {
  const winByKey = new Map<string, Triple>();
  for (const w of group.winners) winByKey.set(liveKey(w.s, w.p), w);
  if (!winByKey.size) return;
  const lost = new Set<string>();
  try {
    for (const l of losingTriples(group.candidates)) lost.add(`${liveKey(l.s, l.p)}\0${normObj(l.o)}`);
  } catch {}
  for (const r of group.recs) {
    try {
      const facts = extractIdentity(r);
      if (!facts.length) continue;
      if (/\b(?:instead of|rather than)\b/i.test(r.text) || /\binstead\b/i.test(r.text)) {
        const won = facts.map((fact) => ({ fact, o: winByKey.get(liveKey(fact.s, fact.p))?.o })).find((f) => f.o);
        if (won && !rewrites.has(r.id)) rewrites.set(r.id, identitySentence(won.fact.s, won.fact.p, won.o!));
      }
      if (String(r.kind ?? "") === "episode" || supersededBy.has(r.id)) continue;
      if (!facts.every((fact) => lost.has(`${liveKey(fact.s, fact.p)}\0${normObj(fact.o)}`))) continue;
      const winner = winByKey.get(liveKey(facts[0]!.s, facts[0]!.p))?.recId;
      if (winner && winner !== r.id) supersededBy.set(r.id, winner);
    } catch {}
  }
}

export function consolidate(mem: SleepMem, opts?: ConsolidateOpts): void {
  try {
    if (memoryConsent() !== "on" || mem.sealed) return;
  } catch {
    return;
  }
  if (incrementalExpired(opts)) return;
  try {
    migrateSessionHowTo(mem);
  } catch {}
  try {
    settlePendingRows(mem.dir);
  } catch {}
  const ordered = liveInStoreOrder(mem);
  const groups = scopeGroups(ordered).map((rows) => {
    const candidates = identityCandidates(rows);
    return { recs: rows.map(({ row }) => row), candidates, winners: assemble(candidates) };
  });
  const winners = distinctTriples(groups.flatMap((group) => group.winners));
  const mode: SleepMode = opts?.mode === "incremental" ? "incremental" : "full";
  // Incremental rest must not tombstone a fact the open goal still references.
  // Full replay (Stop / SessionEnd / idle > EDEN_SLEEP_IDLE) keeps today's drops.
  if (mode === "full") {
    // The semantic store's tombstones hold no scope: only rows of unknown scope give them, so a value one scope lost
    // is never scrubbed where another scope still holds it (A4 §3.2).
    try {
      emitAssemblyTombstones(mem.dir, identityCandidates(ordered.filter(({ row }) => row.scope === undefined)));
    } catch {}
    const supersededBy = new Map<string, string>();
    const rewrites = new Map<string, string>();
    for (const group of groups) supersedeLosers(group, supersededBy, rewrites);
    // A fact row whose every value lost goes to history, superseded by the row that won (A4 §3.1). It stays in the
    // store, so reading the transcript again never learns it anew as the newest value.
    if (supersededBy.size && mem.patchWhere)
      mem.patchWhere((r) => {
        const by = supersededBy.get(r.id);
        return by && !superseded(r) ? { ...r, invalidBy: by } : undefined;
      });
    if (rewrites.size && mem.rewriteWhere) mem.rewriteWhere((r) => rewrites.get(r.id));
    // Positive "Always use postgres" is not a copula, so episode LWW never drops it.
    // After the tombstone is on disk, drop or peel that pin so packet and gists
    // do not brief the loser. Fail-open: a scrub throw leaves the pin.
    try {
      const dropIds = new Set<string>();
      const rewrites = new Map<string, string>();
      for (const r of mem.memories()) {
        if (r.kind !== "constraint" || !r.text || !r.id) continue;
        let cleaned = "";
        try {
          cleaned = scrubTombstonedIdentity(r.text, mem.dir);
        } catch {
          continue;
        }
        const norm = r.text.replace(/\s+/g, " ").trim();
        if (!cleaned) dropIds.add(r.id);
        else if (cleaned !== norm) rewrites.set(r.id, cleaned);
      }
      if (dropIds.size && mem.dropWhere) mem.dropWhere((r) => dropIds.has(r.id));
      if (rewrites.size && mem.rewriteWhere) mem.rewriteWhere((r) => rewrites.get(r.id));
    } catch {}
  }
  try {
    fastMemorize(mem, mem.memories());
  } catch {}
  try {
    stampForesight(mem, mem.memories());
  } catch {}
  if (mode === "full") {
    try {
      promotePolicies(mem);
    } catch {}
    try {
      decayHeat(mem, mem.memories());
    } catch {}
    try {
      healWriteAliases(mem);
    } catch {}
  }
  if (incrementalExpired(opts)) return;
  writeSessionGist(mem, winners, opts?.session);
  if (incrementalExpired(opts)) return;
  try {
    promoteNarrativeGists(mem.dir);
  } catch {
    // Fail-open: hier extract must not undo session LWW gists or throw into inject/sleep.
  }
  if (incrementalExpired(opts)) return;
  const session = sleepSession(mem, opts);
  try {
    promoteHowTo(
      mem,
      ordered.map(({ row }) => row),
      session,
    );
  } catch {
    // Fail-open: how-to faults must not undo tombstones/gists or throw into inject.
  }
  if (mode === "full") {
    try {
      replayExperience(mem);
    } catch {
      // Fail-open: experience replay must not undo tombstones/fact gists or throw into inject.
    }
    try {
      // Decay failed rabbit holes only. Do not pass cwd=mem.dir — that would drop
      // skills whose place cells live in the project, not the memory store.
      // Child: never pass cwd/exists (child worktree can look like parent files are gone).
      const child = memIsChild(mem);
      new HowToStore(howtoRoot(mem)).pruneStale(child ? { child: true } : undefined);
    } catch {}
    try {
      writeSleepPostings(mem, mem.memories());
    } catch {}
    try {
      writeMissTaxonomy(mem.dir, mem.memories());
    } catch {}
    try {
      applyMissTaxonomy(mem, mem.memories());
    } catch {}
  }
}

export async function sleep(opts?: { session?: string; dir?: string; mem?: SleepMem }): Promise<void> {
  try {
    if (memoryConsent() !== "on") return;
  } catch {
    return;
  }
  try {
    let mem = opts?.mem;
    if (!mem) {
      const { openMemory } = await import("./index");
      mem = openMemory({ dir: opts?.dir, session: opts?.session });
    }
    consolidate(mem, opts);
  } catch {}
}

/** Incremental sleep wall clock. Unset, blank, or non-finite `EDEN_SLEEP_BUDGET` → 25ms. */
export function sleepBudgetMs(): number {
  try {
    const raw = process.env.EDEN_SLEEP_BUDGET;
    if (raw == null || String(raw).trim() === "") return 25;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 25;
    return Math.floor(n);
  } catch {
    return 25;
  }
}

type SleepClock = { turns: number; bytes: number; lastAt: number; goal?: string };

const incrementalQueued = new Map<string, { mem: SleepMem; opts?: { session?: string; goal?: string } }>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** In-process clock. Disk is for hook spawn N+1. Inject updates this map only. */
const liveClocks = new Map<string, SleepClock>();

function deferTick(fn: () => void): void {
  if (typeof setImmediate === "function") setImmediate(fn);
  else queueMicrotask(fn);
}

const SLEEP_CLOCK = "sleep-clock.json";
const DEFAULT_SLEEP_TURNS = 32;
const DEFAULT_SLEEP_IDLE_MS = 300_000;

function finiteNonNeg(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function blankClock(): SleepClock {
  return { turns: 0, bytes: 0, lastAt: 0 };
}

/**
 * `EDEN_SLEEP_EVERY`: unset → 32 turns; "0"/"off" → disabled; "8" → 8 turns;
 * "64k"/"64kb"/"65536b" → byte threshold, turns 0. Unparseable → conservative default.
 */
export function parseSleepEvery(raw = process.env.EDEN_SLEEP_EVERY): { turns: number; bytes: number } {
  const def = { turns: DEFAULT_SLEEP_TURNS, bytes: 0 };
  try {
    if (raw == null) return def;
    const v = String(raw).trim().toLowerCase();
    if (!v) return def;
    if (v === "0" || v === "off" || v === "false" || v === "none") return { turns: 0, bytes: 0 };
    const bytes = /^(\d+(?:\.\d+)?)\s*(kb|mb|k|m|b)$/.exec(v);
    if (bytes) {
      const n = Number(bytes[1]);
      if (!Number.isFinite(n) || n < 0) return def;
      const unit = bytes[2];
      const mult = unit === "b" ? 1 : unit === "m" || unit === "mb" ? 1024 * 1024 : 1024;
      return { turns: 0, bytes: Math.floor(n * mult) };
    }
    if (/^\d+$/.test(v)) return { turns: Number(v), bytes: 0 };
    return def;
  } catch {
    return def;
  }
}

/** `EDEN_SLEEP_IDLE`: unset → 5 min. "0"/"off" → idle full-sleep disabled. Plain integer is milliseconds. */
export function sleepIdleMs(raw = process.env.EDEN_SLEEP_IDLE): number {
  try {
    if (raw == null) return DEFAULT_SLEEP_IDLE_MS;
    const v = String(raw).trim().toLowerCase();
    if (!v) return DEFAULT_SLEEP_IDLE_MS;
    if (v === "0" || v === "off" || v === "false" || v === "none") return 0;
    if (/^\d+$/.test(v)) {
      const n = Number(v);
      return Number.isFinite(n) ? n : DEFAULT_SLEEP_IDLE_MS;
    }
    return DEFAULT_SLEEP_IDLE_MS;
  } catch {
    return DEFAULT_SLEEP_IDLE_MS;
  }
}

function clockPath(dir: string): string {
  return join(dir, SLEEP_CLOCK);
}

function clockKey(dir: string): string {
  try {
    return dir ? resolve(dir) : "";
  } catch {
    return dir || "";
  }
}

function loadClock(dir: string): SleepClock {
  try {
    if (!dir) return blankClock();
    const key = clockKey(dir);
    const live = liveClocks.get(key);
    if (live) return { ...live };
    const path = clockPath(dir);
    if (!existsSync(path)) return blankClock();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SleepClock>;
    if (!parsed || typeof parsed !== "object") return blankClock();
    const clock: SleepClock = {
      turns: finiteNonNeg(parsed.turns),
      bytes: finiteNonNeg(parsed.bytes),
      lastAt: finiteNonNeg(parsed.lastAt),
    };
    if (typeof parsed.goal === "string") clock.goal = parsed.goal;
    liveClocks.set(key, clock);
    return { ...clock };
  } catch {
    return blankClock();
  }
}

/** Disk clock is turns/bytes/lastAt plus a scrubbed goal. Never session_id, email, or cwd. */
function clockForDisk(clock: SleepClock): SleepClock {
  const out: SleepClock = {
    turns: finiteNonNeg(clock.turns),
    bytes: finiteNonNeg(clock.bytes),
    lastAt: finiteNonNeg(clock.lastAt),
  };
  if (typeof clock.goal === "string" && clock.goal.trim()) {
    try {
      const g = scrubMemoryText(clock.goal).replace(/\bsession_id\b/gi, "[session]");
      if (g.trim()) out.goal = g.trim();
    } catch {}
  }
  return out;
}

function persistClock(dir: string, clock: SleepClock): void {
  try {
    if (!dir) return;
    const path = clockPath(dir);
    writeFileSync(path, JSON.stringify(clockForDisk(clock)));
    try {
      chmodSync(path, 0o600);
    } catch {}
  } catch {}
}

/** Map always. Disk only when `persist` — inject must not wait on sleep-clock.json. */
function saveClock(dir: string, clock: SleepClock, persist = true): void {
  try {
    if (!dir) return;
    liveClocks.set(clockKey(dir), { ...clock });
    if (persist) persistClock(dir, clock);
  } catch {}
}

function activityDir(dirOrMem: string | SleepMem | undefined): string {
  try {
    if (typeof dirOrMem === "string") return dirOrMem;
    if (dirOrMem && typeof dirOrMem.dir === "string") return dirOrMem.dir;
    return "";
  } catch {
    return "";
  }
}

function disarmIdleTimer(dir: string): void {
  try {
    if (!dir) return;
    const key = resolve(dir);
    const t = idleTimers.get(key) ?? idleTimers.get(dir);
    if (t) clearTimeout(t);
    idleTimers.delete(key);
    idleTimers.delete(dir);
  } catch {}
}

/** In-process idle full-sleep. Unref'd so a short hook process can exit. Fail-open. */
function armIdleTimer(dir: string): void {
  try {
    disarmIdleTimer(dir);
    const ms = sleepIdleMs();
    if (!(ms > 0) || !dir) return;
    const key = resolve(dir);
    const t = setTimeout(() => {
      idleTimers.delete(key);
      try {
        const clock = loadClock(dir);
        const idle = sleepIdleMs();
        if (!(idle > 0) || !(clock.lastAt > 0) || Date.now() - clock.lastAt < idle) return;
        void (async () => {
          try {
            const { openMemory } = await import("./index");
            consolidate(openMemory({ dir }), { mode: "full", goal: clock.goal });
            saveClock(dir, { turns: 0, bytes: 0, lastAt: Date.now(), goal: clock.goal });
          } catch {}
        })();
      } catch {}
    }, ms);
    if (typeof t.unref === "function") t.unref();
    idleTimers.set(key, t);
  } catch {}
}

/**
 * Persist turns/bytes/goal at `sleep-clock.json` so hook spawn N+1 sees them.
 * `noteSleepActivity(dir, delta)` is the contract. `noteSleepActivity(mem)` counts one turn
 * so the existing observe call keeps the clock moving. Fail-open. Never throws.
 * In-process map updates immediately; disk write is deferred to maybeIncrementalSleep
 * so inject does not wait on sleep-clock.json. `lastAt` is this activity (idle = gap since then).
 */
export function noteSleepActivity(
  dirOrMem: string | SleepMem,
  delta?: { turns?: number; bytes?: number; goal?: string },
): void {
  try {
    const dir = activityDir(dirOrMem);
    if (!dir) return;
    const clock = loadClock(dir);
    clock.lastAt = Date.now();
    const inferredTurn = typeof dirOrMem === "string" ? 0 : 1;
    const turns = delta && Number.isFinite(Number(delta.turns)) ? Number(delta.turns) : inferredTurn;
    const bytes = delta && Number.isFinite(Number(delta.bytes)) ? Number(delta.bytes) : 0;
    if (turns > 0) clock.turns += Math.floor(turns);
    if (bytes > 0) clock.bytes += Math.floor(bytes);
    if (typeof delta?.goal === "string") clock.goal = delta.goal;
    saveClock(dir, clock, false);
    armIdleTimer(dir);
  } catch {}
}

/**
 * Idle gap ≥ `EDEN_SLEEP_IDLE` → full consolidate. Else turn/byte threshold → incremental.
 * Resets counters after a pass. Consent off and disk faults return. Never throws into inject.
 */
export function maybeIncrementalSleep(mem: SleepMem, opts?: { session?: string; goal?: string }): void {
  try {
    if (memoryConsent() !== "on") return;
  } catch {
    return;
  }
  try {
    const dir = activityDir(mem);
    if (!dir) return;
    const clock = loadClock(dir);
    const now = Date.now();
    const goal = typeof opts?.goal === "string" ? opts.goal : clock.goal;
    const idle = sleepIdleMs();
    const every = parseSleepEvery();
    const idleHit = idle > 0 && clock.lastAt > 0 && now - clock.lastAt >= idle;
    const turnHit = every.turns > 0 && clock.turns >= every.turns;
    const byteHit = every.bytes > 0 && clock.bytes >= every.bytes;
    if (!idleHit && !turnHit && !byteHit) {
      saveClock(dir, clock, true);
      armIdleTimer(dir);
      return;
    }
    const mode: SleepMode = idleHit ? "full" : "incremental";
    consolidate(mem, {
      session: opts?.session,
      mode,
      goal,
      deadline: mode === "incremental" ? now + sleepBudgetMs() : undefined,
    });
    saveClock(dir, { turns: 0, bytes: 0, lastAt: Date.now(), goal }, true);
    armIdleTimer(dir);
  } catch {}
}

/**
 * Clear the in-process idle timer only. Does not delete `sleep-clock.json`
 * (hook `close()` runs every event and must keep the on-disk turn clock).
 */
export function clearSleepTimer(dirOrMem?: string | SleepMem): void {
  try {
    if (dirOrMem == null) {
      for (const t of idleTimers.values()) clearTimeout(t);
      idleTimers.clear();
      return;
    }
    const dir = activityDir(dirOrMem);
    if (!dir) return;
    disarmIdleTimer(dir);
  } catch {}
}

/**
 * Queue one incremental pass for this dir. Never throws. Never calls consolidate inline.
 * Coalesced until the macrotask runs. Inject must not await this.
 */
export function scheduleIncrementalSleep(mem: SleepMem, opts?: { session?: string; goal?: string }): void {
  try {
    const key = String(mem?.dir ?? "");
    if (!key) return;
    const already = incrementalQueued.has(key);
    incrementalQueued.set(key, { mem, opts });
    if (already) return;
    deferTick(() => {
      const job = incrementalQueued.get(key);
      incrementalQueued.delete(key);
      if (!job) return;
      try {
        if (!existsSync(job.mem.dir)) return;
        maybeIncrementalSleep(job.mem, { session: job.opts?.session, goal: job.opts?.goal });
      } catch {
        // Fail-open: a slow or throwing incremental pass must not surface on inject.
      }
    });
  } catch {}
}

/** Test helper: resolve on the next setImmediate (after a previously queued incremental pass). */
export function flushIncrementalSleep(): Promise<void> {
  return new Promise((resolve) => {
    try {
      deferTick(() => resolve());
    } catch {
      resolve();
    }
  });
}
