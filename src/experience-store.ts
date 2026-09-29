/**
 * ExperienceStore: LME / AgentRunbook-C trajectories as **files**, not JSONL cap 2000.
 * Chat-only still works with empty experience — `observe()` does not import this module.
 * Silent inject later (M24); fail-open here; one AgentMemory / one brain (M14): wrap and
 * hook share `{memoryRoot}/experience/`. Store-all at this layer (capped chars only) —
 * never `extractDurable`, never `memory_search`.
 *
 * Smoke: `for (let i = 0; i < 100; i++) store.put({ id: "t" + i, states: [{ url: "https://ex/" + i, t: i }] });`
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { redact } from "../packages/ir/src/redact";
import { HowToStore, type HowToStep } from "./howto-store";
import { memoryConsent } from "./memory-consent";
import { opaqueId, scrubMemoryText, scrubMemoryValue, type MemoryScrubCtx } from "./memory-scrub";
import { isIclExemplar } from "./semantic-store";
import { exitFromResult, filesFromTool } from "./tool-trace";

export const EXPERIENCE_DIRNAME = "experience";
/** Disk budget env. Distinct from JSONL `EDEN_MEMORY_STORE_CAP`. Default 32 MiB. */
export const EXPERIENCE_BYTES_ENV = "EDEN_EXPERIENCE_BYTES";
export const EXPERIENCE_BYTES_DEFAULT = 32 * 1024 * 1024;
export const EXPERIENCE_TREE_CAP = 1200; // AX / accessibility tree chars
export const EXPERIENCE_ACTION_CAP = 400;
export const EXPERIENCE_THOUGHT_CAP = 600;
export const EXPERIENCE_VERIFY_CAP = 400;
export const EXPERIENCE_STATE_CAP = 40; // states kept per traj
export const EXPERIENCE_FILES_MAX = 32;
export const EXPERIENCE_FILE_CAP = 200;

export type ExperienceState = {
  url?: string;
  action?: string;
  thought?: string;
  tree?: string; // capped AX tree — NEVER run extractDurable
  t?: number;
  /** Tool/process exit. 0 = success for how-to mint. Never extractDurable. */
  exit?: number;
  /** Test/verify command (`pytest` / `bun test` / `npm test`). */
  verify?: string;
  goal?: string;
  outcome?: string;
  files?: string[];
};

export type ExperienceTraj = {
  id: string;
  session?: string;
  /** Scrub needle only — never persisted to disk. */
  cwd?: string;
  states: ExperienceState[];
  exit?: number;
  verify?: string;
  goal?: string;
  outcome?: string;
  files?: string[];
};

const ROOT_FILES = ["semantic.jsonl", "gists.jsonl", "howto.jsonl", "memories.jsonl"] as const;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const ID_MAX = 128;
const BROWSER_NAME = /browser|playwright|snapshot|navigate|computer|web_search|puppeteer|chrome/i;
const AX_HINT = /RootWebArea|\[landmark\]|role:|\bAX\b/;
const TREE_KEYS = ["accessibility_tree", "ax_tree", "accessibilityTree", "tree", "snapshot"] as const;
const URL_KEYS = ["url", "page_url", "current_url"] as const;
const ACTION_KEYS = ["action"] as const;
const THOUGHT_KEYS = ["thought"] as const;
const GOAL_KEYS = ["goal"] as const;
const OUTCOME_KEYS = ["outcome"] as const;
const VERIFY_FIELD_KEYS = ["verify"] as const;
const CMD_KEYS = ["command", "cmd", "script"] as const;
const ALT_KEYS = ["alt", "caption", "altText", "alt_text"] as const;
const IMAGE_KEY = /^(?:screenshot|image|image_data|imagedata|png|jpe?g|webp|gif|bytes|bitmap|screenshot_uri|screenshoturi|screenshot_url|screenshoturl|image_url|imageurl)$/i;
/** Same family as M10 sleep VERIFY_CMD — do not mint how-to from `ls` / `git grep`. */
const VERIFY_CMD = /\b(?:pytest|vitest|jest|mocha)\b|\b(?:bun|cargo|go)\s+test\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/i;
const IMAGE_B64 = /^(?:data:image\/|iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/;
const B64_ONLY = /^[A-Za-z0-9+/=\s]+$/;

function jsonlFile(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isFile();
  } catch {
    return false;
  }
}

function dirNamed(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isDirectory();
  } catch {
    return false;
  }
}

function parentLooksLikeRoot(parent: string): boolean {
  for (const marker of ROOT_FILES) {
    if (jsonlFile(parent, marker)) return true;
  }
  return dirNamed(parent, EXPERIENCE_DIRNAME);
}

/**
 * Session subdirectory → memory root. This dir has memories.jsonl and the parent
 * looks like a memory root (semantic/gists/howto/memories.jsonl / experience/).
 * One level only. Fail-open: stat throw or a non-session dir returns `dir` unchanged.
 */
function resolveExperienceDir(dir: string): string {
  try {
    if (typeof dir !== "string") return dir;
    const d = dir.trim();
    if (!d) return dir;
    if (!jsonlFile(d, "memories.jsonl")) return d;
    const parent = dirname(d);
    if (!parent || parent === d) return d;
    if (parentLooksLikeRoot(parent)) return parent;
    return d;
  } catch {
    return dir;
  }
}

function hashId(raw: string): string {
  return createHash("sha256").update(String(raw), "utf8").digest("hex").slice(0, 32);
}

/** `[A-Za-z0-9._-]+` only; otherwise hash. No `/`, `..`, cwd in filenames. */
function safeId(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s || s === "." || s.includes("..") || s.includes("/") || s.includes("\\") || s.includes("\0")) {
    return hashId(s || "id");
  }
  try {
    const cwd = process.cwd();
    if (cwd && s.includes(cwd)) return hashId(s);
  } catch {}
  if (!SAFE_ID.test(s) || s.length > ID_MAX) return hashId(s);
  return s;
}

function experienceBytesCap(): number {
  const n = Number(process.env[EXPERIENCE_BYTES_ENV]);
  return Number.isFinite(n) && n > 0 ? n : EXPERIENCE_BYTES_DEFAULT;
}

function asTime(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : Date.now();
}

function asField(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

function asExit(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function isImageKey(k: string): boolean {
  return IMAGE_KEY.test(k);
}

function isImagePayloadString(s: string): boolean {
  const t = String(s ?? "").trim();
  if (!t) return false;
  if (IMAGE_B64.test(t)) return true;
  if (t.length > 2000 && B64_ONLY.test(t) && !/\s{8,}/.test(t)) return true;
  return false;
}

function asFileList(v: unknown, ctx?: MemoryScrubCtx): string[] {
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === "string" && v.trim() ? [v] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const s = cleanText(x, EXPERIENCE_FILE_CAP, ctx);
    if (!s || seen.has(s) || isImagePayloadString(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= EXPERIENCE_FILES_MAX) break;
  }
  return out;
}

type ExperienceExtras = {
  exit?: number;
  verify?: string;
  goal?: string;
  outcome?: string;
  files?: string[];
};

function readExtras(o: Record<string, unknown>, ctx?: MemoryScrubCtx): ExperienceExtras {
  const out: ExperienceExtras = {};
  const exit = asExit(o.exit);
  if (exit !== undefined) out.exit = exit;
  const verify = cleanText(asField(o.verify), EXPERIENCE_VERIFY_CAP, ctx);
  if (verify && !isImagePayloadString(verify)) out.verify = verify;
  const goal = cleanText(asField(o.goal), EXPERIENCE_THOUGHT_CAP, ctx);
  if (goal && !isImagePayloadString(goal)) out.goal = goal;
  const outcome = cleanText(asField(o.outcome), EXPERIENCE_THOUGHT_CAP, ctx);
  if (outcome && !isImagePayloadString(outcome)) out.outcome = outcome;
  const files = asFileList(o.files, ctx);
  if (files.length) out.files = files;
  return out;
}

function assignExtras<T extends ExperienceExtras>(target: T, extras: ExperienceExtras): T {
  if (typeof extras.exit === "number" && Number.isFinite(extras.exit)) target.exit = extras.exit;
  if (extras.verify) target.verify = extras.verify;
  if (extras.goal) target.goal = extras.goal;
  if (extras.outcome) target.outcome = extras.outcome;
  if (extras.files?.length) target.files = extras.files.slice(0, EXPERIENCE_FILES_MAX);
  return target;
}

function extrasPresent(st: ExperienceExtras): boolean {
  return st.exit != null
    || Boolean(st.verify)
    || Boolean(st.goal)
    || Boolean(st.outcome)
    || Boolean(st.files && st.files.length);
}

function cleanText(text: string, cap: number, ctx?: MemoryScrubCtx): string {
  let s = String(text ?? "");
  if (!s) return "";
  try {
    const r = redact(s);
    if (typeof r === "string") s = r;
  } catch {}
  try {
    s = scrubMemoryText(s, ctx);
  } catch {}
  if (cap > 0 && s.length > cap) s = s.slice(0, cap);
  return s;
}

function scrubCtx(session?: string, cwd?: string): MemoryScrubCtx | undefined {
  const s = typeof session === "string" ? session.trim() : "";
  const c = typeof cwd === "string" ? cwd.trim() : "";
  if (!s && !c) return undefined;
  const ctx: MemoryScrubCtx = {};
  if (s) ctx.session = s;
  if (c) ctx.cwd = c;
  return ctx;
}

function hashedSession(raw?: string): string | undefined {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s ? opaqueId(s) : undefined;
}

function normalizeState(raw: unknown, ctx?: MemoryScrubCtx): ExperienceState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let o = raw as Record<string, unknown>;
  try {
    const v = scrubMemoryValue(o, ctx);
    if (v && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {}
  const url = cleanText(asField(o.url), 0, ctx);
  const action = cleanText(asField(o.action), EXPERIENCE_ACTION_CAP, ctx);
  const thoughtRaw = asField(o.thought);
  const thought = isImagePayloadString(thoughtRaw) ? "" : cleanText(thoughtRaw, EXPERIENCE_THOUGHT_CAP, ctx);
  const tree = cleanText(asField(o.tree), EXPERIENCE_TREE_CAP, ctx);
  const st: ExperienceState = { t: asTime(o.t) };
  if (url) st.url = url;
  if (action && !isImagePayloadString(action)) st.action = action;
  if (thought) st.thought = thought;
  if (tree) st.tree = tree;
  assignExtras(st, readExtras(o, ctx));
  return st;
}

function stateUseful(st: ExperienceState | null): st is ExperienceState {
  if (!st) return false;
  return Boolean(st.url || st.action || st.thought || st.tree || extrasPresent(st));
}

function capStates(states: ExperienceState[]): ExperienceState[] {
  if (states.length <= EXPERIENCE_STATE_CAP) return states;
  return states.slice(-EXPERIENCE_STATE_CAP);
}

function isMetaLine(o: Record<string, unknown>): boolean {
  const hasMeta = typeof o.id === "string" || typeof o.session === "string";
  if (!hasMeta) return false;
  return o.url == null && o.action == null && o.thought == null && o.tree == null && o.t == null;
}

function asStoredState(o: Record<string, unknown>): ExperienceState | null {
  const st: ExperienceState = {};
  if (typeof o.url === "string" && o.url) st.url = o.url;
  if (typeof o.action === "string" && o.action) st.action = o.action;
  if (typeof o.thought === "string" && o.thought) st.thought = o.thought;
  if (typeof o.tree === "string" && o.tree) st.tree = o.tree;
  if (typeof o.t === "number" && Number.isFinite(o.t)) st.t = o.t;
  assignExtras(st, readExtras(o));
  if (!st.url && !st.action && !st.thought && !st.tree && st.t == null && !extrasPresent(st)) return null;
  return st;
}

type Loaded = ExperienceExtras & { id?: string; session?: string; states: ExperienceState[] };

function loadFile(path: string): Loaded {
  const out: Loaded = { states: [] };
  try {
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const t = line.replace(/\r$/, "");
      if (!t) continue;
      try {
        const v = JSON.parse(t) as unknown;
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const o = v as Record<string, unknown>;
        if (typeof o.id === "string" && o.id.trim()) out.id = o.id.trim();
        if (typeof o.session === "string" && o.session.trim()) out.session = o.session.trim();
        if (isMetaLine(o)) {
          assignExtras(out, readExtras(o));
          continue;
        }
        const st = asStoredState(o);
        if (st) out.states.push(st);
      } catch {
        // Torn or invalid line — skip.
      }
    }
  } catch {}
  return out;
}

function persistStateRow(st: ExperienceState): ExperienceState {
  const row: ExperienceState = {};
  if (st.url) row.url = st.url;
  if (st.action) row.action = st.action;
  if (st.thought) row.thought = st.thought;
  if (st.tree) row.tree = st.tree;
  if (st.t != null && Number.isFinite(st.t)) row.t = st.t;
  assignExtras(row, st);
  return row;
}

function persistFile(path: string, traj: ExperienceExtras & { id: string; session?: string; states: ExperienceState[] }): void {
  const lines: string[] = [];
  const meta: ExperienceExtras & { id: string; session?: string } = { id: traj.id };
  if (traj.session) meta.session = traj.session;
  assignExtras(meta, traj);
  lines.push(JSON.stringify(meta));
  for (const st of traj.states) {
    lines.push(JSON.stringify(persistStateRow(st)));
  }
  writeFileAtomic(path, lines.join("\n") + "\n");
  try { chmodSync(path, 0o600); } catch {}
}

type FileStat = { path: string; size: number; mtime: number };

function listTrajFiles(expDir: string): FileStat[] {
  const out: FileStat[] = [];
  try {
    if (!existsSync(expDir)) return out;
    for (const name of readdirSync(expDir)) {
      if (!name.endsWith(".jsonl") || name.startsWith(".")) continue;
      if (name === "memories.jsonl") continue;
      const p = join(expDir, name);
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
  } catch {}
  return out;
}

/** Delete oldest traj files until under disk budget. Never memories.jsonl. Never throw. */
function enforceBudget(expDir: string): void {
  try {
    const cap = experienceBytesCap();
    const files = listTrajFiles(expDir);
    let total = 0;
    for (const f of files) total += f.size;
    if (total <= cap) return;
    files.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
    for (let i = 0; i < files.length && total > cap; i++) {
      if (i === files.length - 1) break; // keep newest even if still over
      const f = files[i]!;
      try {
        unlinkSync(f.path);
        total -= f.size;
      } catch {}
    }
  } catch {}
}

function ensureExpDir(root: string, expDir: string): boolean {
  try {
    mkdirSync(expDir, { recursive: true });
    try { chmodSync(root, 0o700); } catch {}
    try { chmodSync(expDir, 0o700); } catch {}
    return true;
  } catch {
    return false;
  }
}

function trajPath(expDir: string, id: string): string {
  return join(expDir, `${safeId(id)}.jsonl`);
}

function writesOk(): boolean {
  try {
    return memoryConsent() === "on";
  } catch {
    return false;
  }
}

function isAxText(s: string): boolean {
  return AX_HINT.test(s);
}

const TREE_KEY_SET = new Set<string>(TREE_KEYS);

/**
 * Drop AX / accessibility_tree from a tool payload so the short episodic
 * JSONL note cannot echo the haystack. Experience files keep the tree.
 * Never throws.
 */
export function omitExperienceTree(value: unknown): unknown {
  try {
    if (value == null) return value;
    if (typeof value === "string") {
      const obj = asRecord(value);
      if (obj) {
        try {
          return JSON.stringify(omitExperienceTree(obj));
        } catch {
          return AX_HINT.test(value) ? "" : value;
        }
      }
      return AX_HINT.test(value) ? "" : value;
    }
    if (Array.isArray(value)) return value.map((x) => omitExperienceTree(x));
    if (typeof value === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (TREE_KEY_SET.has(k)) continue;
        o[k] = omitExperienceTree(v);
      }
      return o;
    }
    return value;
  } catch {
    return value;
  }
}

function pickString(o: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    if (!(k in o) || o[k] == null) continue;
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return "";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        const p = JSON.parse(t) as unknown;
        if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
      } catch {}
    }
  }
  return null;
}

type Extracted = {
  url: string;
  action: string;
  thought: string;
  tree: string;
  goal: string;
  outcome: string;
  verify: string;
};

function takeAlt(o: Record<string, unknown>): string {
  const alt = pickString(o, ALT_KEYS);
  return alt && !isImagePayloadString(alt) ? alt : "";
}

function takeCmd(o: Record<string, unknown>): string {
  const cmd = pickString(o, CMD_KEYS);
  return cmd && !isImagePayloadString(cmd) ? cmd : "";
}

function extractedFull(acc: Extracted): boolean {
  return Boolean(acc.url && acc.action && acc.thought && acc.tree && acc.goal && acc.outcome && acc.verify);
}

function walkAltOnly(v: unknown, depth: number, acc: Extracted): void {
  if (depth > 5 || v == null) return;
  if (typeof v === "string") {
    if (isImagePayloadString(v)) return;
    const obj = asRecord(v);
    if (obj) walkAltOnly(obj, depth + 1, acc);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) walkAltOnly(x, depth + 1, acc);
    return;
  }
  if (typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  const alt = takeAlt(o);
  if (alt) {
    if (!acc.thought) acc.thought = alt;
    if (!acc.outcome) acc.outcome = alt;
  }
  for (const [k, child] of Object.entries(o)) {
    if (isImageKey(k) && typeof child === "string") continue;
    walkAltOnly(child, depth + 1, acc);
  }
}

function walkExtract(v: unknown, depth: number, acc: Extracted): void {
  if (depth > 5 || v == null) return;
  if (typeof v === "string") {
    if (isImagePayloadString(v)) return;
    if (!acc.tree && isAxText(v)) acc.tree = v;
    const obj = asRecord(v);
    if (obj) walkExtract(obj, depth + 1, acc);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) {
      if (extractedFull(acc)) return;
      walkExtract(x, depth + 1, acc);
    }
    return;
  }
  if (typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (!acc.tree) {
    const tree = pickString(o, TREE_KEYS);
    if (tree && !isImagePayloadString(tree)) acc.tree = tree;
  }
  if (!acc.url) acc.url = pickString(o, URL_KEYS);
  if (!acc.action) acc.action = pickString(o, ACTION_KEYS);
  if (!acc.thought) {
    const thought = pickString(o, THOUGHT_KEYS);
    if (thought && !isImagePayloadString(thought)) acc.thought = thought;
  }
  if (!acc.goal) acc.goal = pickString(o, GOAL_KEYS);
  if (!acc.outcome) acc.outcome = pickString(o, OUTCOME_KEYS);
  if (!acc.verify) {
    const named = pickString(o, VERIFY_FIELD_KEYS);
    if (named && VERIFY_CMD.test(named)) acc.verify = named;
    else {
      const cmd = takeCmd(o);
      if (cmd && VERIFY_CMD.test(cmd)) acc.verify = cmd;
    }
  }
  const alt = takeAlt(o);
  if (alt) {
    if (!acc.thought) acc.thought = alt;
    if (!acc.outcome) acc.outcome = alt;
  }
  for (const [k, child] of Object.entries(o)) {
    if (extractedFull(acc)) return;
    if (isImageKey(k)) {
      walkAltOnly(child, depth + 1, acc);
      continue;
    }
    walkExtract(child, depth + 1, acc);
  }
}

function resultBlob(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return isImagePayloadString(result) ? "" : result;
  const o = asRecord(result);
  if (!o) return "";
  const parts = [o.stdout, o.stderr, o.text, o.content, o.output, o.message]
    .filter((x): x is string => typeof x === "string" && x.length > 0 && !isImagePayloadString(x));
  if (parts.length) return parts.join("\n");
  try {
    const slim: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (isImageKey(k)) continue;
      if (typeof v === "string" && isImagePayloadString(v)) continue;
      slim[k] = v;
    }
    return JSON.stringify(slim);
  } catch {
    return "";
  }
}

function argsRecord(args: unknown): Record<string, unknown> {
  return asRecord(args) ?? {};
}

function deriveTrajId(payload: { id?: string; name?: string }, extracted: Extracted, t: number): string {
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  if (id) return id;
  const name = typeof payload.name === "string" ? payload.name : "";
  return hashId(`${name}\0${extracted.url}\0${t}`);
}

export class ExperienceStore {
  readonly dir: string;
  private readonly expDir: string;
  private readonly lockPath: string;

  constructor(dir: string) {
    let root = typeof dir === "string" ? dir : "";
    try {
      root = resolveExperienceDir(root);
    } catch {
      root = typeof dir === "string" ? dir : "";
    }
    this.dir = root;
    this.expDir = join(root, EXPERIENCE_DIRNAME);
    this.lockPath = `${this.expDir}.lock`;
    // Do not mkdir here: get/ids on a missing dir must stay ENOENT, and chat
    // observe must not create experience/ just by constructing the store.
  }

  /** Write a traj file (meta + states). Replaces that id's file. Never throws. */
  put(traj: ExperienceTraj): void {
    try {
      if (!writesOk()) return;
      if (!traj || typeof traj !== "object") return;
      const id = typeof traj.id === "string" ? traj.id.trim() : "";
      if (!id) return;
      const rawSession = typeof traj.session === "string" ? traj.session.trim() : "";
      const rawCwd = typeof traj.cwd === "string" ? traj.cwd.trim() : "";
      const ctx = scrubCtx(rawSession, rawCwd);
      const incoming = Array.isArray(traj.states) ? traj.states : [];
      const states = capStates(
        incoming.map((s) => normalizeState(s, ctx)).filter((s): s is ExperienceState => s != null),
      );
      const stem = safeId(id);
      const path = join(this.expDir, `${stem}.jsonl`);
      const row: ExperienceExtras & { id: string; session?: string; states: ExperienceState[] } = {
        id: stem,
        session: hashedSession(rawSession),
        states,
      };
      assignExtras(row, readExtras(traj as unknown as Record<string, unknown>, ctx));
      withFileLock(this.lockPath, () => {
        if (!ensureExpDir(this.dir, this.expDir)) return;
        persistFile(path, row);
        enforceBudget(this.expDir);
      });
    } catch {
      // Fail-open: lock/disk faults must not throw into observe/inject.
    }
  }

  /** Append one state to a traj file (creates it). Never throws. */
  append(id: string, state: ExperienceState, extra?: { session?: string; cwd?: string }): void {
    try {
      if (!writesOk()) return;
      const rawId = typeof id === "string" ? id.trim() : "";
      if (!rawId) return;
      const rawSession = typeof extra?.session === "string" ? extra.session.trim() : "";
      const rawCwd = typeof extra?.cwd === "string" ? extra.cwd.trim() : "";
      const ctx = scrubCtx(rawSession, rawCwd);
      const st = normalizeState(state, ctx);
      if (!st || !stateUseful(st)) return;
      const stem = safeId(rawId);
      const path = join(this.expDir, `${stem}.jsonl`);
      withFileLock(this.lockPath, () => {
        if (!ensureExpDir(this.dir, this.expDir)) return;
        const prev = loadFile(path);
        const session = hashedSession(rawSession) || prev.session;
        const states = capStates([...prev.states, st]);
        const row: ExperienceExtras & { id: string; session?: string; states: ExperienceState[] } = {
          id: stem,
          session,
          states,
        };
        assignExtras(row, prev);
        persistFile(path, row);
        enforceBudget(this.expDir);
      });
    } catch {
      // Fail-open.
    }
  }

  /** Missing dir / ENOENT → null. Corrupt lines skipped. Never throws. */
  get(id: string): ExperienceTraj | null {
    try {
      const rawId = typeof id === "string" ? id.trim() : "";
      if (!rawId) return null;
      const path = trajPath(this.expDir, rawId);
      if (!existsSync(this.expDir) || !existsSync(path)) return null;
      const loaded = loadFile(path);
      const stem = safeId(rawId);
      const traj: ExperienceTraj = { id: loaded.id || stem, states: loaded.states };
      if (loaded.session) traj.session = loaded.session;
      assignExtras(traj, loaded);
      return traj;
    } catch {
      return null;
    }
  }

  /** Missing dir → []. Never throws. */
  ids(): string[] {
    try {
      if (!existsSync(this.expDir)) return [];
      const out: string[] = [];
      for (const f of listTrajFiles(this.expDir)) {
        const name = basename(f.path);
        if (name.endsWith(".jsonl")) out.push(name.slice(0, -".jsonl".length));
      }
      return out;
    } catch {
      return [];
    }
  }
}

/** Convenience: same as new ExperienceStore(dir).put(...) */
export function putExperience(dir: string, traj: ExperienceTraj): void {
  try {
    new ExperienceStore(dir).put(traj);
  } catch {}
}

export function readExperience(dir: string, id: string): ExperienceTraj | null {
  try {
    return new ExperienceStore(dir).get(id);
  } catch {
    return null;
  }
}

/**
 * Tool/browser payload → ExperienceStore. Extract url/action/thought/tree from
 * args + result. If nothing tool/browser-shaped, no-op. Never throws.
 * Used by wrap tool-observe and hook PostToolUse (M23.2).
 */
export function putExperienceFromTool(
  dir: string,
  payload: {
    id?: string;
    session?: string;
    cwd?: string;
    name?: string;
    args?: Record<string, unknown>;
    result?: unknown;
  },
): void {
  try {
    if (!writesOk()) return;
    const name = typeof payload?.name === "string" ? payload.name : "";
    const acc: Extracted = { url: "", action: "", thought: "", tree: "", goal: "", outcome: "", verify: "" };
    const args = argsRecord(payload?.args);
    walkExtract(payload?.args, 0, acc);
    walkExtract(payload?.result, 0, acc);
    if (typeof payload?.result === "string" && !acc.tree && isAxText(payload.result)) {
      acc.tree = payload.result;
    }
    const blob = resultBlob(payload?.result);
    let exit: number | undefined;
    try {
      exit = exitFromResult({ ...asRecord(payload?.result), ...args }, blob);
    } catch {
      exit = undefined;
    }
    let files: string[] = [];
    try {
      files = filesFromTool(args, blob).slice(0, EXPERIENCE_FILES_MAX);
    } catch {
      files = [];
    }
    if (!acc.verify) {
      const cmd = takeCmd(args);
      if (cmd && VERIFY_CMD.test(cmd)) acc.verify = cmd;
    }
    if (!acc.action && name && (acc.verify || exit !== undefined)) acc.action = name;
    const named = name ? BROWSER_NAME.test(name) : false;
    const hasShape = Boolean(acc.url || acc.action || acc.thought || acc.tree);
    const hasSuccess = Boolean(acc.verify || acc.goal || acc.outcome);
    if (!named && !hasShape && !hasSuccess) return;
    if (!hasShape && !hasSuccess) return;
    const t = Date.now();
    const id = deriveTrajId(payload ?? {}, acc, t);
    const state: ExperienceState = { t };
    if (acc.url) state.url = acc.url;
    if (acc.action) state.action = acc.action;
    if (acc.thought) state.thought = acc.thought;
    if (acc.tree) state.tree = acc.tree;
    if (acc.goal) state.goal = acc.goal;
    if (acc.outcome) state.outcome = acc.outcome;
    if (acc.verify) state.verify = acc.verify;
    if (exit !== undefined) state.exit = exit;
    if (files.length) state.files = files;
    new ExperienceStore(dir).append(id, state, { session: payload?.session, cwd: payload?.cwd });
  } catch {
    // Fail-open: bad payloads must not throw into wrap/hook.
  }
}

function isVerifyString(s: string): boolean {
  return Boolean(s && VERIFY_CMD.test(s));
}

function pickVerify(st: ExperienceState): string {
  if (typeof st.verify === "string" && isVerifyString(st.verify)) return st.verify.trim();
  if (typeof st.action === "string" && isVerifyString(st.action)) return st.action.trim();
  return "";
}

function unionStateFiles(traj: ExperienceTraj, prefer?: ExperienceState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (f: string) => {
    const t = f.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const f of prefer?.files ?? []) add(f);
  for (const f of traj.files ?? []) add(f);
  for (const st of traj.states) {
    for (const f of st.files ?? []) add(f);
  }
  return out.slice(0, EXPERIENCE_FILES_MAX);
}

function iclHay(parts: Array<string | undefined>): boolean {
  try {
    for (const p of parts) {
      if (typeof p === "string" && p.trim() && isIclExemplar(p)) return true;
    }
  } catch {}
  return false;
}

function asTrajArg(v: unknown): ExperienceTraj | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as ExperienceTraj;
  if (typeof o.id !== "string" || !Array.isArray(o.states)) return null;
  return o;
}

/** Last verify-like state (or traj meta). Promote only when that exit is 0. */
function pickSuccess(traj: ExperienceTraj): { st: ExperienceState; verify: string; files: string[]; t: number } | null {
  let found: { st: ExperienceState; verify: string } | null = null;
  for (const st of traj.states) {
    const verify = pickVerify(st);
    if (verify) found = { st, verify };
  }
  if (!found && typeof traj.verify === "string" && isVerifyString(traj.verify)) {
    found = {
      st: traj.states[traj.states.length - 1] ?? { t: Date.now() },
      verify: traj.verify.trim(),
    };
  }
  if (!found) return null;
  let exit: number | undefined;
  if (typeof found.st.exit === "number" && Number.isFinite(found.st.exit)) exit = found.st.exit;
  else if (typeof traj.exit === "number" && Number.isFinite(traj.exit)) exit = traj.exit;
  else {
    for (let i = traj.states.length - 1; i >= 0; i--) {
      const e = traj.states[i]?.exit;
      if (typeof e === "number" && Number.isFinite(e)) {
        exit = e;
        break;
      }
    }
  }
  if (exit !== 0) return null;
  const files = unionStateFiles(traj, found.st);
  let t = typeof found.st.t === "number" && Number.isFinite(found.st.t) ? found.st.t : 0;
  if (!t) {
    for (const st of traj.states) {
      if (typeof st.t === "number" && Number.isFinite(st.t) && st.t > t) t = st.t;
    }
  }
  return { st: found.st, verify: found.verify, files, t: t || Date.now() };
}

function toHowToSteps(traj: ExperienceTraj, success: { st: ExperienceState; verify: string }): HowToStep[] {
  const steps: HowToStep[] = [];
  for (let i = 0; i < traj.states.length; i++) {
    const st = traj.states[i]!;
    if (typeof st.exit === "number" && st.exit !== 0) continue;
    const name = (typeof st.action === "string" && st.action.trim()) ? st.action.trim() : "";
    if (!name && st !== success.st) continue;
    const step: HowToStep = { name: name || "tool", order: i };
    if (st === success.st && success.verify) step.args = { command: success.verify };
    if (st.files?.length) step.files = st.files.slice(0, EXPERIENCE_FILES_MAX);
    if (typeof st.exit === "number" && Number.isFinite(st.exit)) step.exit = st.exit;
    steps.push(step);
  }
  if (!steps.length) {
    const name = (typeof success.st.action === "string" && success.st.action.trim())
      ? success.st.action.trim()
      : "tool";
    const step: HowToStep = { name, exit: 0, order: 0, args: { command: success.verify } };
    if (success.st.files?.length) step.files = success.st.files.slice(0, EXPERIENCE_FILES_MAX);
    steps.push(step);
  }
  return steps;
}

function mintExperienceHowTo(howtoDir: string, traj: ExperienceTraj): void {
  try {
    const picked = pickSuccess(traj);
    if (!picked) return;
    const thought = typeof picked.st.thought === "string" ? picked.st.thought : "";
    const url = typeof picked.st.url === "string" ? picked.st.url : "";
    const goal = (typeof picked.st.goal === "string" && picked.st.goal) || traj.goal || "";
    const outcome = (typeof picked.st.outcome === "string" && picked.st.outcome) || traj.outcome || "";
    if (iclHay([thought, picked.st.action, picked.verify, goal, outcome, url, traj.goal, traj.outcome])) return;
    const cue = [url, picked.files.join(" "), thought, goal]
      .filter((s) => typeof s === "string" && s.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 800) || picked.verify;
    if (iclHay([cue])) return;
    const steps = toHowToSteps(traj, picked);
    if (!cue && !steps.length && !picked.files.length) return;
    try {
      new HowToStore(howtoDir).put({
        cue,
        steps,
        files: picked.files,
        verify: picked.verify,
        exit: 0,
        t: picked.t,
      });
    } catch {
      // HowToStore.put throw swallowed.
    }
  } catch {
    // Fail-open: one traj must not abort sleep/replay.
  }
}

/**
 * Compress a successful experience traj into HowToStore. Never throws.
 *
 * Callers:
 * - Batch (pin tests / sleep without a traj): `promoteExperienceHowTo(dir, { session? })`
 *   reads ExperienceStore ids/get. Missing dir / empty ids → zero HowToStore writes.
 * - Per-traj (M25.1 replayExperience): `promoteExperienceHowTo(howtoRoot, traj)`.
 *
 * Mint only when `exit === 0` **and** a verify-like test command exists.
 * `exit !== 0` or missing verify stays episodic (file untouched). ICL text skipped.
 * Never unlinks or rewrites experience jsonl.
 */
export function promoteExperienceHowTo(dir: string, opts?: { session?: string } | ExperienceTraj): void {
  try {
    if (typeof dir !== "string" || !dir.trim()) return;
    if (!writesOk()) return;
    const traj = asTrajArg(opts);
    if (traj) {
      mintExperienceHowTo(dir, traj);
      return;
    }
    const store = new ExperienceStore(dir);
    let ids: string[] = [];
    try {
      ids = store.ids();
    } catch {
      return;
    }
    if (!ids.length) return;
    const sessionWant = hashedSession(typeof opts?.session === "string" ? opts.session : undefined);
    for (const id of ids) {
      try {
        const got = store.get(id);
        if (!got || !Array.isArray(got.states)) continue;
        if (sessionWant && got.session && got.session !== sessionWant) continue;
        mintExperienceHowTo(dir, got);
      } catch {
        // Corrupt / missing file — skip.
      }
    }
  } catch {
    // Fail-open: ENOENT / HowToStore / parse must not throw into sleep.
  }
}
