import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { alreadyInjected, injectFromRequest, injectNote } from "../packages/know/src/inject";
import { redact } from "../packages/ir/src/redact";
import { assembleNotes, splitNumberedItems } from "./assemble";
import { completeNotes } from "./cls/complete";
import { memoryConsent } from "./memory-consent";
import { applyObserveForget } from "./memory-forget";
import { dropHarmed, loadHarmedIds, markHarmed as persistHarmed } from "./memory-harmed";
import { clearSleepTimer, consolidate, migrateSessionHowTo, noteSleepActivity, scheduleIncrementalSleep } from "./sleep";
import { retrieveHowTo } from "./howto-retrieve";
import {
  retrieveExperience,
  EXPERIENCE_RETRIEVE_K,
  EXPERIENCE_RETRIEVE_K_MAX,
  EXPERIENCE_SLICE_TOKEN_CAP,
  EXPERIENCE_SLICE_CHAR_CAP,
} from "./experience-retrieve";
import { retrieveNarrativeChunks } from "./chunk-retrieve";
import { retrieveGists, isSummaryCue, isBookQaCue, leftoverChunksForGists, GIST_CHAR_CAP } from "./gist-retrieve";
import { ChunkStore } from "./chunk-store";
import { IclIndex, retrieveIcl } from "./icl-index";
import { opaqueProject, scrubMemoryText } from "./memory-scrub";
import { type MemoryLaneKind } from "./memory-lanes";
import { logMemoryNotes } from "./memory-log";
import { applyProvenanceLabel, noteKindToken, PACKET_LABEL_RE, stripPacketLabel } from "./memory-provenance";
import { routeMemory, type MemoryRoute } from "./memory-router";
import { isIclExemplar, isRecsysShot, objectAsserted, SemanticStore } from "./semantic-store";

export { isRecsysShot } from "./semantic-store";

export { memoryConsent, memoryWritesAllowed, type MemoryConsent } from "./memory-consent";
export { dropHarmed, harmedPath, loadHarmedIds, markHarmed } from "./memory-harmed";
export { applyProvenanceLabel, packetKindLabel, relativeMemoryAge, provenanceBracket, PACKET_LABEL_RE } from "./memory-provenance";
export { logMemoryNotes, memoryLogEnabled } from "./memory-log";
export const MEMORY_MARK = "Eden Memory:";
export const memoryInjectSwallows = { n: 0 };
export const memoryInjectSilent = { n: 0 };
export const MEMORY_MIN_DEFAULT = 0.15;
export const memoryLastRoute = { route: "chat-jsonl" as MemoryRoute };
const MEMORY_X_FAT_CHARS = 2400;

export function isMathChatterCue(cue: string): boolean {
  try {
    const t = String(cue ?? "").trim();
    if (!t) return false;
    if (/\b(?:auth|sqlite|postgres|clerk|flake|commit|test|database|provider|session|file|src\/|\.ts|\.py|adr)\b/i.test(t)) {
      return false;
    }
    const lower = t.toLowerCase();
    if (/^(?:ok|okay|thanks|thank you|lol|lmao|asdf|qwerty|hi|hey|yo)\s*[.!?]?\s*$/i.test(lower)) return true;
    if (/^\s*(?:what(?:'s| is)\s+)?\d+\s*(?:\+|plus|\-|minus|\*|x|×|times|\/|÷|divided by)\s*\d+\s*\??\s*$/i.test(lower)) {
      return true;
    }
    if (/\b(?:times|plus|minus|divided by)\b/.test(lower) && /\d/.test(lower) && lower.split(/\s+/).length <= 8) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function fatPacket<T extends { text?: string }>(recs: T[], k: number): T[] {
  try {
    const list = Array.isArray(recs) ? recs : [];
    const out: T[] = [];
    let chars = 0;
    const floor = Math.max(1, Math.floor(Number(k) || 6));
    for (const r of list) {
      const n = String(r.text ?? "").length;
      if (out.length >= floor && chars + n > MEMORY_X_FAT_CHARS) continue;
      out.push(r);
      chars += n;
      if (chars >= MEMORY_X_FAT_CHARS && out.length >= floor) break;
    }
    return out.length ? out : list.slice(0, floor);
  } catch {
    return Array.isArray(recs) ? recs : [];
  }
}

/** Floor for inject. Unset, empty, NaN, or negative → 0.15. Fail-open. */
export function memoryMinAboutness(): number {
  try {
    const raw = process.env.EDEN_MEMORY_MIN;
    if (raw == null || String(raw).trim() === "") return MEMORY_MIN_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return MEMORY_MIN_DEFAULT;
    return n;
  } catch {
    return MEMORY_MIN_DEFAULT;
  }
}

export type MemoryKind = "fact" | "preference" | "episode" | "procedure" | "constraint" | string;
export type MemoryRecord = { id: string; text: string; kind: MemoryKind; tags: string[]; agent?: string; project?: string; at: number; ep?: string; ctx?: Record<string, number>; sal?: number; lane?: MemoryLaneKind };
export type KnowSearch = { search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[]; close?: () => void };
export type MemoryOptions = { dir?: string; know?: KnowSearch; agent?: string; project?: string; session?: string; cwd?: string; child?: boolean };

/**
 * Safe session subdirectory. Rejects `/`, `\`, and `..` traversal.
 * `--` is the child-session marker (a suffix, not a nested path) and is allowed.
 * Empty/unsafe → caller uses root jsonl.
 */
export function memorySessionName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || s.includes("\0") || s.includes("/") || s.includes("\\")) return undefined;
  if (s.split("--").join("").includes("..")) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") return undefined;
  return s;
}

/**
 * Episodic child file is `<parent>--<child>`, not `<parent>/<child>` (sanitizer rejects `/`).
 * Both segments pass `memorySessionName`. No parent → child alone. No child → parent alone.
 * Unit: a child opened on the same `dir` injects parent sqlite via `mergeRootIdentity(this.dir)` after the parent has slept. Child JSONL stays under the suffix.
 */
export function childSessionName(parent?: string, child?: string): string | undefined {
  try {
    const p = memorySessionName(parent);
    const c = memorySessionName(child);
    if (p && c) return memorySessionName(`${p}--${c}`);
    return c ?? p;
  } catch {
    return undefined;
  }
}

/**
 * True when the sanitized name contains `--`, the separator `childSessionName` writes.
 * Not a forget/prune gate: Claude session ids are UUIDs (single `-`). A parent opened
 * as `foo--bar` without `opts.child` still tombstones root. Hook and wrap set `child`.
 */
export function isChildSession(session?: string): boolean {
  const s = memorySessionName(session);
  return !!s && s.includes("--");
}

type Compiled = { rec: MemoryRecord; needles: string[] };

const STOP = new Set(["the","of","is","a","an","on","to","and","in","for","this","that","with","from","into","about","these","then","still","has","out","please","how","should","what","why","was","are","you","your","its","our","not","never","use","used","just","last","week","down","look","next","need","before","merge","prefers","user","memory","ran","fact","such","or","no","app"]);

function tokList(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [];
}

const NEAR_DUP_J = 0.8;

function dedupSelect<T extends { rec: MemoryRecord; n: number }>(pool: T[], cap: number): MemoryRecord[] {
  const prior = (): MemoryRecord[] => {
    const n = Math.floor(Number(cap));
    const limit = Number.isFinite(n) && n > 0 ? n : 0;
    return pool.slice(0, limit).map((x) => x.rec);
  };
  try {
    const limit = Math.floor(Number(cap));
    if (!Number.isFinite(limit) || limit <= 0 || !pool.length) return [];
    const picked: T[] = [];
    const lanes: string[] = [];
    const stems: Set<string>[] = [];
    for (const cand of pool) {
      if (picked.length >= limit) break;
      const lane = packetLane(cand.rec);
      const bag = nearDupStems(cand.rec.text);
      let dup = false;
      for (let i = 0; i < picked.length; i++) {
        if (lanes[i] !== lane) continue;
        if (iclLabelsDiffer(cand.rec, picked[i]!.rec)) continue;
        if (stemJaccard(bag, stems[i]!) >= NEAR_DUP_J) { dup = true; break; }
      }
      if (dup) continue;
      picked.push(cand);
      lanes.push(lane);
      stems.push(bag);
    }
    return picked.map((x) => x.rec);
  } catch {
    return prior();
  }
}

/** Packet bucket for near-dup. Jaccard never crosses lanes. */
function packetLane(rec: { lane?: string; kind?: string; text?: string }): string {
  try {
    const text = String(rec?.text ?? "");
    if (rec?.lane === "icl" || isIclExemplar(text)) return "icl";
    if (rec?.kind === "procedure") return "procedure";
    if (rec?.lane === "trajectory") return "trajectory";
    if (rec?.kind === "gist" || rec?.kind === "digest") return "gist";
    if (rec?.lane === "narrative") return "narrative";
    return "chat";
  } catch {
    return "chat";
  }
}

function iclLabelKey(text: string): string {
  try {
    const m = String(text ?? "").match(/\blabel\s*:\s*(\S+)/i);
    if (!m?.[1]) return "";
    return m[1].replace(/[.,;:!?]+$/g, "").trim().toLowerCase();
  } catch {
    return "";
  }
}

/** Different ICL labels are not clones, even when the utterance overlaps. */
function iclLabelsDiffer(a: { text?: string }, b: { text?: string }): boolean {
  const la = iclLabelKey(String(a?.text ?? ""));
  const lb = iclLabelKey(String(b?.text ?? ""));
  return !!la && !!lb && la !== lb;
}

/** Stem set for near-dup. STOP words drop when any content stem remains. */
function nearDupStems(text: string): Set<string> {
  const all = new Set<string>();
  const content = new Set<string>();
  try {
    for (const w of tokList(String(text ?? ""))) {
      if (!w) continue;
      all.add(w);
      if (!STOP.has(w)) content.add(w);
    }
  } catch {}
  return content.size ? content : all;
}

function stemJaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

function suppressPacketNearDups(recs: MemoryRecord[]): MemoryRecord[] {
  try {
    if (!Array.isArray(recs) || recs.length < 2) return recs;
    const picked: { rec: MemoryRecord; stems: Set<string>; lane: string }[] = [];
    const out: MemoryRecord[] = [];
    for (const rec of recs) {
      const lane = packetLane(rec);
      const bag = nearDupStems(rec.text);
      let dup = false;
      for (const p of picked) {
        if (p.lane !== lane) continue;
        if (iclLabelsDiffer(rec, p.rec)) continue;
        if (stemJaccard(bag, p.stems) >= NEAR_DUP_J) { dup = true; break; }
      }
      if (dup) continue;
      picked.push({ rec, stems: bag, lane });
      out.push(rec);
    }
    return out;
  } catch {
    return recs;
  }
}

export function queryHay(text: string): Set<string> {
  return new Set(tokList(text));
}

const TOOL_ROLES = new Set(["tool", "function"]);
const TOOL_BLOCKS = new Set(["tool_result", "tool_use", "function_call", "function_result"]);

function convBlob(list: unknown[]): string {
  if (list.length === 1) {
    const o = list[0] as Record<string, unknown> | undefined;
    const role = String(o?.role ?? "").toLowerCase();
    // Tool payloads belong on ExperienceStore + observeToolTraces, not extractDurable JSONL.
    if (TOOL_ROLES.has(role)) return "";
    if (typeof o?.content === "string" && !(o.reasoning_content || o.thinking || o.reasoning)) return o.content;
  }
  const parts: string[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>, c = o.content ?? o.llmContent;
    const role = String(o.role ?? "").toLowerCase();
    if (TOOL_ROLES.has(role)) continue;
    if (typeof c === "string" && c) parts.push(c);
    else if (Array.isArray(c) || Array.isArray(o.parts) || (c && typeof c === "object" && Array.isArray((c as Record<string, unknown>).parts))) {
      for (const b of (Array.isArray(c) ? c : Array.isArray(o.parts) ? o.parts as unknown[] : (c as Record<string, unknown>).parts as unknown[])) {
        if (b && typeof b === "object") {
          const type = String((b as Record<string, unknown>).type || "").toLowerCase();
          if (TOOL_BLOCKS.has(type)) continue;
          const t = ["text","content","llmContent","value"].map((k) => (b as Record<string, unknown>)[k]).find((v) => typeof v === "string" && v);
          if (t) parts.push(t as string);
        }
      }
    }
    const r = o.reasoning_content ?? o.thinking ?? o.reasoning; if (typeof r === "string" && r) parts.push(r);
  }
  return parts.join("\n");
}

/** This-turn rank cue: latest user text only. Not the conversation window, last-8, or transcript-40. */
export function cueFor(list: unknown[]): string {
  if (!Array.isArray(list) || !list.length) return "";
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || typeof m !== "object") continue;
    const role = String((m as { role?: unknown }).role ?? "").toLowerCase();
    if (role === "system") continue;
    const text = convBlob([m]).trim();
    if (!text || text.startsWith(MEMORY_MARK)) continue;
    if (role === "user" || role === "human") return text;
  }
  return "";
}

const PLACE_PATH_KEYS = ["open_files", "openFiles", "files", "file_paths", "filePaths", "file_path", "filePath", "path", "filename", "file", "recently_viewed_files", "recentlyViewedFiles"] as const;
const PLACE_GOAL_KEYS = ["last_goal", "lastGoal", "current_goal", "currentGoal"] as const;
const PLACE_OBJ_KEYS = ["path", "file_path", "filePath", "filename", "uri", "name"] as const;
const PLACE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PLACE_DOTTED = /^[A-Za-z0-9_-]+(?:\.[A-Za-z][A-Za-z0-9]*)+$/;
const PLACE_SEG = /^[A-Za-z0-9_.@+-]+$/;
const PLACE_CAP = 8;

/** Dotted basename, and every slash-segment is a path token. Code is not a path. */
function placeLooksLikePath(s: string): boolean {
  const parts = s.split("/").filter(Boolean);
  if (!parts.length || !parts.every((p) => PLACE_SEG.test(p))) return false;
  return PLACE_DOTTED.test(parts[parts.length - 1] ?? "");
}

function placeCwdList(): string[] {
  const out: string[] = [];
  try {
    const n = process.cwd().trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (n.length >= 2) out.push(n);
  } catch {}
  return out;
}

function placePush(out: string[], name: string): void {
  const n = name.trim();
  if (!n || n.length > 120 || /[\r\n]/.test(n) || PLACE_EMAIL.test(n)) return;
  const key = n.toLowerCase();
  if (out.some((x) => x.toLowerCase() === key) || out.length >= PLACE_CAP) return;
  out.push(n);
}

/** Basename plus a short relative path. Absolute leftovers keep the dotted basename only. */
function placeNamesFromString(raw: string, cwds: string[], out: string[]): void {
  let s = raw.trim();
  if (!s || s.length > 200 || /[\r\n]/.test(s) || PLACE_EMAIL.test(s) || /^cwd$/i.test(s)) return;
  s = s.replace(/^file:\/\//i, "").replace(/\\/g, "/").replace(/[?#].*$/, "").replace(/\/+$/, "");
  try { if (s.includes("%")) s = decodeURIComponent(s); } catch {}
  if (!s || s.length > 200 || /[\r\n]/.test(s) || PLACE_EMAIL.test(s)) return;
  for (const c of cwds) {
    if (s.toLowerCase() === c.toLowerCase()) return;
    if (s.toLowerCase().startsWith(c.toLowerCase() + "/")) {
      s = s.slice(c.length).replace(/^\/+/, "");
      break;
    }
  }
  if (!s || s === "." || s === "..") return;
  if (s.startsWith("/") || /^[A-Za-z]:\//.test(s)) {
    const parts = s.split("/").filter(Boolean);
    if (!parts.every((p) => PLACE_SEG.test(p))) return;
    const base = parts[parts.length - 1] ?? "";
    if (PLACE_DOTTED.test(base)) placePush(out, base);
    return;
  }
  if (!placeLooksLikePath(s)) return;
  const base = s.split("/").filter(Boolean).pop() ?? "";
  if (PLACE_DOTTED.test(base)) placePush(out, base);
  if (s.length <= 120 && s.includes("/") && s.toLowerCase() !== base.toLowerCase()) placePush(out, s);
}

function placeAddValue(v: unknown, cwds: string[], out: string[], depth: number): void {
  if (out.length >= PLACE_CAP || depth > 4) return;
  if (typeof v === "string") {
    if (/[,;]/.test(v) && !/[\r\n]/.test(v)) {
      for (const part of v.split(/[,;]/)) placeNamesFromString(part, cwds, out);
      return;
    }
    placeNamesFromString(v, cwds, out);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) placeAddValue(item, cwds, out, depth + 1);
    return;
  }
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  for (const k of PLACE_OBJ_KEYS) if (k in o) placeAddValue(o[k], cwds, out, depth + 1);
}

function placeAddGoal(text: string, out: string[]): void {
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return;
  try {
    for (const tok of pathCues(text.replace(PLACE_EMAIL, " "))) {
      if (out.length >= PLACE_CAP) return;
      if (!placeLooksLikePath(tok)) continue;
      placePush(out, tok);
    }
  } catch {}
}

function placeScan(o: Record<string, unknown>, cwds: string[], out: string[], depth: number): void {
  if (depth > 1) return;
  if (typeof o.cwd === "string") {
    const n = o.cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (n.length >= 2 && !cwds.some((x) => x.toLowerCase() === n.toLowerCase())) cwds.push(n);
  }
  for (const k of PLACE_PATH_KEYS) if (k in o) placeAddValue(o[k], cwds, out, 0);
  for (const k of PLACE_GOAL_KEYS) if (typeof o[k] === "string") placeAddGoal(o[k], out);
  if (depth === 0) {
    for (const nest of ["context", "editor"] as const) {
      const child = o[nest];
      if (child && typeof child === "object" && !Array.isArray(child)) placeScan(child as Record<string, unknown>, cwds, out, depth + 1);
    }
  }
}

/** Path names only. Never file bodies, cwd, emails, or transcript text. */
export function placePathsFrom(raw: unknown): string[] {
  try {
    const out: string[] = [];
    const cwds = placeCwdList();
    if (typeof raw === "string") {
      placeAddValue(raw, cwds, out, 0);
      return out;
    }
    if (Array.isArray(raw)) {
      placeAddValue(raw, cwds, out, 0);
      return out;
    }
    if (!raw || typeof raw !== "object") return [];
    placeScan(raw as Record<string, unknown>, cwds, out, 0);
    return out;
  } catch {
    return [];
  }
}

/** Append unique pathCues-able names to this-turn cue. cueFor itself is unchanged. */
export function attachPlaceCues(cue: string, paths: Iterable<string>): string {
  const base = typeof cue === "string" ? cue : "";
  const trimmed = base.trim();
  const hay = trimmed.toLowerCase();
  const names: string[] = [];
  const seen = new Set<string>();
  try {
    for (const p of paths) {
      const name = String(p ?? "").trim();
      if (!name || name.length > 120 || /[\r\n]/.test(name) || PLACE_EMAIL.test(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key) || hay.includes(key)) continue;
      seen.add(key);
      names.push(name);
    }
  } catch {}
  if (!trimmed && !names.length) return "";
  if (!trimmed) return names.join(" ");
  if (!names.length) return base;
  return `${trimmed} ${names.join(" ")}`;
}

/** Same scan as cueFor: latest user/human message object, or undefined. */
function lastUserMessage(list: unknown[]): unknown {
  if (!Array.isArray(list) || !list.length) return undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || typeof m !== "object") continue;
    const role = String((m as { role?: unknown }).role ?? "").toLowerCase();
    if (role === "system") continue;
    const text = convBlob([m]).trim();
    if (!text || text.startsWith(MEMORY_MARK)) continue;
    if (role === "user" || role === "human") return m;
  }
  return undefined;
}

const WRAP_PLACE_FIELDS = ["open_files", "openFiles", "files", "file_paths", "filePaths", "file_path", "filePath", "recently_viewed_files", "recentlyViewedFiles"] as const;

function stripWrapPlaceFields(body: Record<string, unknown>): Record<string, unknown> {
  let dirty = false;
  for (const k of WRAP_PLACE_FIELDS) if (k in body) { dirty = true; break; }
  if (!dirty) return body;
  const out = { ...body };
  for (const k of WRAP_PLACE_FIELDS) delete out[k];
  return out;
}

const CHAT = /^(ok|okay|thanks|thank you|got it|sure|yeah|yep|hmm|wait|anyway|nah|hey|yo|lol|haha|lmao|nope|np|wow|whoa|idk|dunno|alright|gotcha|sounds good|lgtm|ack|cheers|ty|gg|brb|nvm|omg|kk|yup|thx|ttyl|smh|wfm|idc|ngl|fr|ikr|meh|ugh|welp|yikes|oops|huh)\b/i;
/** Peel intentional memory wrappers before the chat-filler gate. Bare "Please fix…" is experience, not filler. */
const ACK_PREFIX = /^(?:(?:please\s+remember|remember(?:\s+that)?|got it|understood(?:[,']?\s*I'?ll follow that)?|for reference|fyi|heads up|one rule(?:\s+for\s+this\s+repo)?|going forward)[:,!.]?\s+)+/i;
const SPEAKER_LABEL = /^([A-Z][A-Za-z0-9 /._-]{1,32}:)(?=\s)/;

const FUNC_WORD = new Set([
  "i","we","you","he","she","they","my","our","your","his","her","their","me","us","him","them",
  "is","are","was","were","am","be","been","being","has","have","had","having",
  "do","does","did","will","would","can","could","should","must","might","may",
  "the","a","an","and","but","of","to","in","on","at","for","with","from","by","as","that","this",
  "these","those","it","its","because","if","so","also","when","who","which","not","no",
]);
function looksNarrative(t: string): boolean {
  const toks = tokList(t);
  if (toks.length < 4) return false;
  let fw = 0;
  for (const w of toks) if (FUNC_WORD.has(w) && ++fw >= 2) return true;
  return false;
}

const SECRET_INLINE = /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9/_-]+/g;

function sentenceParts(t: string): string[] {
  return t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8);
}

/** Numbered / copula fact lists stay chat so FC-SH overwrite still extractDurable. */
function isFactList(t: string): boolean {
  // Packet labels (`[fact] 1. …`) must not hide serials: inject formatNote runs after notesFor.
  const numbered = t.split(/\n/).filter((l) => /^\s*(?:\[[a-z][a-z0-9_-]*(?:\s*·[^\]]*)?\]\s+)?\d+[.)]\s+/.test(l));
  if (numbered.length >= 2) return true;
  const sents = sentenceParts(t);
  if (sents.length < 2) return false;
  let copula = 0;
  for (const s of sents) {
    try { if (objectAsserted(s)) copula++; } catch {}
  }
  return copula >= 2 && copula * 2 >= sents.length;
}

/** EventQA-class prose: long or multi-sentence narrative, not ICL, not identity lists. */
function isNarrativeProse(t: string): boolean {
  const text = t.trim();
  if (isIclExemplar(text) || isFactList(text)) return false;
  if (text.length > 400) return true;
  return sentenceParts(text).length >= 2 && text.length >= 150 && looksNarrative(text);
}

/**
 * System/live identity must not leftover inside store-all prose.
 * Drops conflicting copula sentences only. Does not extractDurable the novel.
 */
function stripDeadObjects(text: string, store: SemanticStore): string {
  const raw = String(text ?? "");
  if (!raw) return raw;
  try {
    const live = store.live();
    if (!Array.isArray(live) || !live.length) return raw;
    let t = raw;
    for (const row of live) {
      const s = String(row?.s ?? "").trim();
      const liveO = String(row?.o ?? "").trim();
      if (s.length < 3 || liveO.length < 2) continue;
      const subj = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      const obj = liveO.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(
        new RegExp(`(?:the\\s+)?${subj}\\s+(?:is\\s+now|are\\s+now|was|were|is|are)\\s+(?!${obj}\\b)[A-Za-z][A-Za-z0-9-]*`, "gi"),
        "",
      );
    }
    t = t.replace(/\s+/g, " ").trim();
    return t || raw;
  } catch {
    return raw;
  }
}

function omitConflictingIdentity(text: string, store: SemanticStore): string {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  try {
    const parts = sentenceParts(raw);
    const units = parts.length ? parts : [raw];
    const kept: string[] = [];
    for (const s of units) {
      try {
        const fact = objectAsserted(s);
        if (fact) {
          const live = store.get(fact.s, fact.p);
          if (live && live.o.trim().toLowerCase() !== fact.o.trim().toLowerCase()) continue;
          if (store.supersededObject(fact.o)) continue;
        }
      } catch {}
      kept.push(s);
    }
    return kept.join(" ").trim();
  } catch {
    return raw;
  }
}

export function encodeLane(text: string): MemoryLaneKind {
  try {
    const t = String(text ?? "").trim();
    if (!t) return "chat";
    if (isIclExemplar(t)) return "icl";
    if (isRecsysShot(t)) return "narrative";
    if (isNarrativeProse(t)) return "narrative";
    return "chat";
  } catch {
    return "chat";
  }
}

/** Operator pin on the pre-strip utterance. Not "don't remember", "never remember", or "don't forget". */
function isPinUtterance(text: string): boolean {
  if (/\b(?:don'?t|do not|never)\s+remember\b/i.test(text)) return false;
  if (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(text)) return true;
  if (/\balways\s+\S/i.test(text)) return true;
  return false;
}

function observeAsserted(text: string): { s: string; p: string; o: string } | undefined {
  const a = objectAsserted(text);
  if (a) return a;
  const raw = String(text ?? "").trim().replace(/\s+/g, " ").replace(/^\d+[.)]\s+/, "");
  if (!raw || raw.endsWith("?")) return undefined;
  const became = raw.match(/^(?:the\s+)?(.{1,80}?)\s+(?:became|becomes)\s+(\S.*)$/i);
  if (became) {
    const s = became[1]!.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const o = became[2]!.replace(/[.,;:!?]+$/g, "").trim();
    if (s && o) return { s, p: "is", o };
  }
  const d = raw.match(/\b(?:decided|chose|picked|went with|going with|settled on|opted for)\s+(?:to\s+)?(?:use|go with)?\s*(.{1,40}?)\s+for\s+(.{1,40}?)(?=\s+(?:because|since|as|so)\b|[.,;:!?]|$)/i);
  if (!d) return undefined;
  const o = d[1]!.replace(/^(?:the|a|an)\s+/i, "").replace(/[.,;:!?]+$/g, "").trim();
  const s = d[2]!.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return s && o ? { s, p: "is", o } : undefined;
}

function extractDurable(blob: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  let whole = blob.trim().replace(/\s+/g, " ").replace(ACK_PREFIX, "");
  if (SPEAKER_LABEL.test(whole) && whole.endsWith("?") && /[.!]/.test(whole.slice(0, -1))) whole = whole.replace(/\s+[^.!?]+\?\s*$/, "").trim();
  const labeledWhole = SPEAKER_LABEL.test(whole) && whole.length <= 800 && !whole.endsWith("?");
  const iclWhole = isIclExemplar(whole);
  const numberedWhole = /^\d+[.)]\s+\S/.test(whole);
  const label = whole.match(SPEAKER_LABEL)?.[1];
  for (const raw of labeledWhole || iclWhole ? [whole] : numberedWhole ? splitNumberedItems(whole) : blob.replace(ACK_PREFIX, "").split(/(?:(?<=\n)|(?<=[.!?])(?<!\d\.))\s+/)) {
    let t = raw.trim().replace(/\s+/g, " ").replace(/^(i think|i believe|i guess|maybe|perhaps|tbh|imo)\s+/i, "").replace(ACK_PREFIX, "");
    t = t.replace(SECRET_INLINE, "[REDACTED]");
    if (t.length < 8 || t.length > (labeledWhole ? 800 : 400) || t.startsWith("{") || t.startsWith("[") || t.startsWith("http") || t.startsWith("#") || /^(const|let|import |export |function )\b/.test(t) || t.includes(MEMORY_MARK) || t.includes("Eden Know:") || CHAT.test(t)) continue;
    if (label && !SPEAKER_LABEL.test(t)) t = `${label} ${t}`;
    const rem = /\b(?:don'?t|do not|never)\s+remember\b/i.test(t) ? null : t.match(/\bremember(?: that)?\s+(.+)/i); if (rem) t = rem[1]!.trim();
    t = t.replace(/^[.\s]+|[.\s]+$/g, "");
    if (SPEAKER_LABEL.test(t)) {
      const sp = new Set(tokList((t.match(SPEAKER_LABEL)?.[1] || "").replace(/:$/, "")));
      if (!tokList(t).some((w) => !sp.has(w) && (w.length >= 5 || /^\d/.test(w)) && !STOP.has(w))) continue;
    }
    if (t.length >= 8 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

/** Path prefixes / directory segments mentioned in text: "generated/", "tests/integration", "src/x/y.ts" → generated, tests, integration, tests/integration, src, x. */
export function pathCues(lower: string): Set<string> {
  const out = new Set<string>();
  lower = lower.toLowerCase();
  for (const m of lower.matchAll(/(?:^|[\s"'`(,:])((?:[a-z0-9_.-]+\/)+[a-z0-9_.-]*)/g)) {
    const segs = m[1]!.split("/").filter((s) => s.length >= 3);
    for (const s of segs) out.add(s);
    if (segs.length >= 2) out.add(segs.slice(0, 2).join("/"));
  }
  // Bare dotted filenames ("auth.ts", "hook.ts") are place cells even without a slash.
  for (const m of lower.matchAll(/(?:^|[\s"'`(,:])([a-z0-9_-]+(?:\.[a-z][a-z0-9]*)+)\b/g)) {
    if (m[1]!.length >= 3) out.add(m[1]!);
  }
  return out;
}

const SAL_STRONG = /\b(root cause|because|instead of|rather than|decided|we chose|chose|settled on|going with|never|always|do not|don'?t|must|the fix (?:was|is)|fixed (?:it )?by|turned out|the reason|that'?s why|that is why|so that)\b/i;
const SAL_WEAK = /\b(?:i|we) (?:changed|added|fixed|raised|moved|switched|replaced|set|bumped|pointed|deleted|removed|rewrote|derived|forced|chunked|serialised|serialized|used|wired|dropped|renamed|reverted|pinned|upgraded|downgraded|disabled|enabled|patched|migrated|recreated)\b|\b(?:should|prefer|convention|rule|instead)\b/i;
function salience(text: string): number {
  const t = text.replace(SPEAKER_LABEL, "");
  return SAL_STRONG.test(t) ? 1 : SAL_WEAK.test(t) ? 0.6 : 0;
}

function compile(rec: MemoryRecord): Compiled {
  const own = new Set([
    ...rec.tags.filter((t) => t.length >= 3 && !STOP.has(t)),
    ...tokList(rec.text).filter((w) => w.length >= 3 && !STOP.has(w)),
  ]);
  return { rec, needles: [...own] };
}

const jaccardText = (a: string, b: string): number => { const A = new Set(tokList(a)), B = new Set(tokList(b)); let i = 0; for (const w of A) if (B.has(w)) i++; const u = A.size + B.size - i; return u ? i / u : 0; };

/** Store size. Distinct from retrieve k (`EDEN_MEMORY_CAP`). */
function storeCap(): number {
  return Number(process.env.EDEN_MEMORY_STORE_CAP) || 2000;
}

/** Append-only sibling of memories.jsonl. Compact under the same lock. */
export const MEMORY_WAL_SUFFIX = ".wal";
/** Compact when WAL has this many lines (or eviction / close / drop). */
export const MEMORY_WAL_COMPACT_LINES = 32;

export function memoryWalPath(path: string): string {
  return `${path}${MEMORY_WAL_SUFFIX}`;
}

function ingestMemoryJsonl(path: string, out: Compiled[], idx: Map<string, number>, overlay: boolean): void {
  if (!existsSync(path)) return;
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return; }
  for (const t of raw.split("\n")) {
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as MemoryRecord;
      if (rec?.id && rec.text) {
        rec.lane = rec.lane ?? "chat";
        const c = compile(rec);
        const at = idx.get(rec.id);
        if (overlay && at != null) out[at] = c;
        else {
          idx.set(rec.id, out.length);
          out.push(c);
        }
      }
    } catch {}
  }
}

function walLineCount(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    let n = 0;
    for (const t of readFileSync(path, "utf8").split("\n")) if (t) n++;
    return n;
  } catch {
    return 0;
  }
}

/** Append JSONL; if the file has a torn last line (no trailing newline), start a new line first. */
function appendJsonl(path: string, blob: string): void {
  let prefix = "";
  try {
    if (existsSync(path)) {
      const prev = readFileSync(path, "utf8");
      if (prev.length && !prev.endsWith("\n")) prefix = "\n";
    }
  } catch {}
  appendFileSync(path, prefix + blob);
}

function load(path: string): Compiled[] {
  const out: Compiled[] = [];
  const idx = new Map<string, number>();
  ingestMemoryJsonl(path, out, idx, false);
  ingestMemoryJsonl(memoryWalPath(path), out, idx, true);
  return out;
}

const STATUS_OBJECT = /\b(?:failing|broken|down|flaky|crashing|hanging|erroring|working|ready|live|dead|ok|fine|slow|errors?|offline|unavailable)\b/i;

export function subjectKey(text: string): string | null {
  // Chat prefixes + assistant "Understood, I'll follow that:" must not merge distinct rules.
  // Bare "use" (as in "use two spaces") is not a copula — only "uses"/"using".
  const cleaned = text.trim()
    .replace(/^(?:fyi|for reference|heads up|noted|got it|note|ok|okay|update|reminder|understood(?:[,']?\s*I'?ll follow that)?|one rule(?: for this repo)?|going forward)[:,]?\s+/i, "")
    .replace(/^I'?ll follow that:\s*/i, "");
  // Env acronym slot: "CI: X" / "CI is now Y" share one key so stale CI labels supersede.
  // Status ("CI is failing") is not identity — leave the prior value until M7 tombstone.
  const ci = cleaned.match(/^ci(?:\s+is(?:\s+now)?|:)\s+(\S.*)$/i);
  if (ci) return STATUS_OBJECT.test(ci[1]!) ? null : "ci";
  const m = cleaned.match(/^(.{4,80}?)\s+(?:is now|are now|is|are|was|were|prefers?|uses\b|using\b|lives in|live in|stays in|stay in|moved to|belongs to|owned by|ship from|ships from)\s+(\S.*)$/i);
  if (!m) return null;
  // Status/event objects are not identity: "Auth is failing" must not share "auth" with "Auth is Clerk".
  if (STATUS_OBJECT.test(m[2]!)) return null;
  const k = m[1]!.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return k.length >= 4 ? k : null;
}

export const PACKET_CHAT_K_MIN = 6;
export const PACKET_CHAT_K_MAX = 10;
export const PACKET_CHAT_K_DEFAULT = PACKET_CHAT_K_MIN;
export const PROCEDURE_TOKEN_CAP = 300;
export const PROCEDURE_CHAR_CAP = PROCEDURE_TOKEN_CAP * 4;
export const FACT_CHAR_CAP = PROCEDURE_CHAR_CAP;

export function memoryRetrieveCap(): number {
  const raw = Number(process.env.EDEN_MEMORY_CAP);
  if (!Number.isFinite(raw) || raw <= 0) return PACKET_CHAT_K_DEFAULT;
  return Math.min(PACKET_CHAT_K_MAX, Math.max(PACKET_CHAT_K_MIN, Math.floor(raw)));
}

export {
  EXPERIENCE_RETRIEVE_K,
  EXPERIENCE_RETRIEVE_K_MAX,
  EXPERIENCE_SLICE_TOKEN_CAP,
  EXPERIENCE_SLICE_CHAR_CAP,
};

/** Slice how-to body; drop trailing · segments first; keep `verify:` when present. */
function formatProcedureBody(text: string): string {
  const redacted = redact(String(text ?? ""));
  const t = typeof redacted === "string" ? redacted : String(text ?? "");
  if (t.length <= PROCEDURE_CHAR_CAP) return t;
  const vm = t.match(/^(.*?)((?:\s*·\s*|\s+)verify:\s*)(.*)$/is);
  if (vm) {
    const head = vm[1]!;
    const tail = `${vm[2]!}${vm[3]!}`;
    if (head.length + tail.length <= PROCEDURE_CHAR_CAP) return t;
    const room = PROCEDURE_CHAR_CAP - tail.length;
    if (room > 0) return `${head.slice(0, room)}${tail}`;
    return tail.slice(0, PROCEDURE_CHAR_CAP).trimStart();
  }
  return t.slice(0, PROCEDURE_CHAR_CAP);
}

/** Cap [fact] body only. Keep an existing `[fact]` prefix; do not double-label. */
function formatFactBody(text: string): string {
  const redacted = redact(String(text ?? ""));
  const t = typeof redacted === "string" ? redacted : String(text ?? "");
  const labeled = t.match(/^(\s*\[fact(?:\s*·[^\]]*)?\]\s*)(.*)$/is);
  if (labeled) {
    const prefix = labeled[1]!;
    const rest = labeled[2]!;
    return rest.length <= FACT_CHAR_CAP ? t : `${prefix}${rest.slice(0, FACT_CHAR_CAP)}`;
  }
  return t.length <= FACT_CHAR_CAP ? t : t.slice(0, FACT_CHAR_CAP);
}

/** Cap [gist] body only. Keep an existing `[gist]` prefix; do not double-label. */
function formatGistBody(text: string): string {
  const redacted = redact(String(text ?? ""));
  const t = typeof redacted === "string" ? redacted : String(text ?? "");
  const labeled = t.match(/^(\s*\[gist(?:\s*·[^\]]*)?\]\s*)(.*)$/is);
  if (labeled) {
    const prefix = labeled[1]!;
    const rest = labeled[2]!;
    return rest.length <= GIST_CHAR_CAP ? t : `${prefix}${rest.slice(0, GIST_CHAR_CAP)}`;
  }
  return t.length <= GIST_CHAR_CAP ? t : t.slice(0, GIST_CHAR_CAP);
}

function formatNote(r: MemoryRecord): MemoryRecord {
  const isProcedure = r.kind === "procedure";
  const raw = typeof r.text === "string" ? r.text : String(r.text ?? "");
  const stripped = stripPacketLabel(raw).body;
  let body = stripped;
  if (isProcedure) body = formatProcedureBody(body);
  else {
    // ICL exemplars / narrative lanes must keep `label:` — never truncate the shot.
    // Numbered fact lists stay whole so assemble can see serial 8, not only the first 1200 chars.
    const skipFactCap = r.lane === "icl" || r.lane === "trajectory" || isIclExemplar(r.text) || isIclExemplar(body) || isNarrativeNote(r)
      || isFactList(r.text) || isFactList(body);
    const factish = r.kind === "fact" || r.kind === "preference" || /^\s*\[fact(?:\s*·[^\]]*)?\]/i.test(body);
    if (!skipFactCap && factish) body = formatFactBody(body);
  }
  try {
    const tags = Array.isArray(r.tags) ? r.tags : [];
    // ICL / trajectory / narrative chunks (episode + tag "chunk") must not be gist-capped.
    const skipGistCap = r.lane === "icl" || r.lane === "trajectory" || isIclExemplar(r.text) || isIclExemplar(body)
      || (r.kind === "episode" && tags.includes("chunk"));
    // Kind / exact tag / [gist] prefix only — a session fact that merely says "gist" stays uncapped.
    const gistish = r.kind === "digest" || r.kind === "gist"
      || tags.some((t) => t === "gist" || t === "digest")
      || /^\s*\[gist(?:\s*·[^\]]*)?\]/i.test(body);
    if (!skipGistCap && gistish) body = formatGistBody(body);
  } catch { /* fail-open: leave body */ }
  let labeled = body;
  try { labeled = applyProvenanceLabel(r, body); } catch {
    try {
      const kind = noteKindToken(r, body);
      labeled = kind ? `[${kind}] ${body}` : body;
    } catch { labeled = body; }
  }
  const copy = { ...r, text: labeled };
  return copy;
}

/** Labeled packet line for hosts that format outside notesFor (SessionStart briefing). */
export function formatPacketText(r: MemoryRecord): string {
  try { return formatNote(r).text; } catch { return String(r?.text ?? ""); }
}

/** How-to aboutness: match values (cue, files, verify-stem, pathCues), not JSON key names. */
const HOWTO_SCHEMA_KEYS = new Set(["command", "cmd", "script", "path", "file", "filepath", "filename"]);
const HOWTO_EXACT = 1_000_000;
const HOWTO_GAP_CMD = /\bpytest\b|\bnpm\b|\brm\s|\bcd\s|\bbash\s|[|;&]/i;

function normHowtoCue(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function howtoVerifyStem(verify?: string): string {
  if (!verify) return "";
  const first = verify.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const cleaned = first.replace(/^['"]+|['"]+$/g, "");
  return (cleaned.split(/[/\\]/).pop() ?? cleaned).trim();
}

function howtoKeepTok(t: string): boolean {
  return t.length >= 2 && !STOP.has(t);
}

function howtoSchemaValues(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || v == null) return out;
  if (typeof v === "string") {
    const looks = /^\s*[{\[]/.test(v) || /"(?:cmd|command|script)"/i.test(v);
    if (!looks) return out;
    try { howtoSchemaValues(JSON.parse(v), out, depth + 1); } catch { /* partial JSON */ }
    const re = /"(command|cmd|script|path|file|filepath|filename)"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(v))) {
      try {
        const s = JSON.parse(`"${m[2]!}"`);
        if (typeof s === "string" && s.trim()) out.push(s.trim());
      } catch { if (m[2]) out.push(m[2]); }
    }
    return out;
  }
  if (Array.isArray(v)) { for (const x of v) howtoSchemaValues(x, out, depth + 1); return out; }
  if (typeof v !== "object") return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (HOWTO_SCHEMA_KEYS.has(k.toLowerCase())) {
      if (typeof val === "string" && val.trim()) out.push(val.trim());
      else if (typeof val === "number" && Number.isFinite(val)) out.push(String(val));
      else howtoSchemaValues(val, out, depth + 1);
    } else howtoSchemaValues(val, out, depth + 1);
  }
  return out;
}

function addHowtoToks(out: Set<string>, text: string, dropStops: boolean) {
  for (const t of tokList(text)) {
    if (dropStops && !howtoKeepTok(t)) continue;
    out.add(t);
  }
  for (const p of pathCues(text.toLowerCase())) out.add(p);
}

function howtoHayText(row: { cue?: string; files?: string[]; verify?: string; steps?: { args?: Record<string, unknown> }[] }): string {
  return [row.cue ?? "", ...(Array.isArray(row.files) ? row.files : []), row.verify ?? "", ...howtoSchemaValues(row.steps ?? [])].join(" ");
}

/** Optional local embed on lexical miss. Absent hook → 0 (degrade). No network, no new dep. */
function howtoEmbedScore(a: string, b: string): number {
  try {
    const fn = (globalThis as { edenHowtoEmbed?: (x: string, y: string) => number }).edenHowtoEmbed;
    if (typeof fn !== "function") return 0;
    const n = Number(fn(a, b));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 0.999) : 0;
  } catch {
    return 0;
  }
}

/** Exact cue, then lexical overlap (values + pathCues + verify-stem). Embed only on miss. */
export function howtoAboutness(cue: string, row: { cue?: string; files?: string[]; verify?: string; steps?: { args?: Record<string, unknown> }[] }): number {
  const q = String(cue ?? "").trim();
  if (!q) return 0;
  const rowCue = typeof row.cue === "string" ? row.cue : "";
  if (normHowtoCue(q) && normHowtoCue(q) === normHowtoCue(rowCue)) return HOWTO_EXACT;
  const qToks = new Set<string>();
  addHowtoToks(qToks, q, true);
  for (const v of howtoSchemaValues(q)) addHowtoToks(qToks, v, true);
  const hay = new Set<string>();
  addHowtoToks(hay, rowCue, true);
  const files = Array.isArray(row.files) ? row.files : [];
  for (const f of files) {
    if (typeof f !== "string") continue;
    addHowtoToks(hay, f, false);
    const base = f.trim().toLowerCase().split(/[/\\]/).pop() ?? "";
    if (base) hay.add(base);
  }
  if (typeof row.verify === "string" && row.verify.trim()) {
    addHowtoToks(hay, row.verify, true);
    const stem = howtoVerifyStem(row.verify);
    if (stem) hay.add(stem);
  }
  for (const v of howtoSchemaValues(row.steps ?? [])) addHowtoToks(hay, v, true);
  let n = 0;
  for (const t of qToks) if (hay.has(t)) n++;
  const qPlaces = new Set<string>();
  for (const p of pathCues(q.toLowerCase())) qPlaces.add(p);
  for (const v of howtoSchemaValues(q)) for (const p of pathCues(v.toLowerCase())) qPlaces.add(p);
  let placeHit = false;
  for (const f of files) {
    if (typeof f !== "string") continue;
    const fl = f.trim().toLowerCase();
    if (!fl) continue;
    const base = fl.split(/[/\\]/).pop() ?? "";
    if ((base && (qPlaces.has(base) || qToks.has(base))) || qPlaces.has(fl)) { placeHit = true; break; }
  }
  const stem = howtoVerifyStem(typeof row.verify === "string" ? row.verify : undefined);
  const stemHit = !!(stem && (qToks.has(stem) || [...qPlaces].includes(stem)));
  // Weak unigrams ("tests") must not dump a skill. Place cells / verify-stem / 2+ overlap.
  if (placeHit || stemHit) return Math.max(n, 1) + (placeHit ? 10 : 0) + (stemHit ? 5 : 0);
  if (n >= 2) return n;
  return howtoEmbedScore(q, howtoHayText(row));
}

function howtoGapReason(view: { gaps?: { reason?: string }[] }): string | undefined {
  const gaps = view.gaps;
  if (!Array.isArray(gaps) || !gaps.length) return undefined;
  const raw = typeof gaps[0]?.reason === "string" ? gaps[0].reason.trim() : "";
  if (!raw || HOWTO_GAP_CMD.test(raw)) return "missing step";
  return raw;
}

function howtoPacketFiles(view: ReturnType<typeof retrieveHowTo>[number]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (f: unknown) => {
    if (typeof f !== "string") return;
    const s = f.trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  if (Array.isArray(view.files)) for (const f of view.files) add(f);
  if (out.length) return out;
  if (!Array.isArray(view.steps)) return out;
  for (const s of view.steps) {
    if (Array.isArray(s?.files)) for (const f of s.files) add(f);
    const args = s?.args;
    if (!args) continue;
    for (const k of ["path", "file", "filepath", "filename"] as const) add(args[k]);
  }
  return out;
}

function howtoPacketVerify(view: ReturnType<typeof retrieveHowTo>[number]): string {
  if (typeof view.verify === "string" && view.verify.trim()) return view.verify.trim();
  if (!Array.isArray(view.steps)) return "";
  for (let i = view.steps.length - 1; i >= 0; i--) {
    const args = view.steps[i]?.args;
    if (!args) continue;
    for (const k of ["command", "cmd", "script"] as const) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

function howtoProcedureRecord(view: ReturnType<typeof retrieveHowTo>[number]): MemoryRecord {
  const cue = typeof view.cue === "string" ? view.cue.trim() : "";
  const files = howtoPacketFiles(view);
  const verify = howtoPacketVerify(view);
  let text = cue;
  if (files.length) text = text ? `${text} → ${files.join(" ")}` : files.join(" ");
  if (verify) text = text ? `${text} · verify: ${verify}` : `verify: ${verify}`;
  const unknown = howtoGapReason(view);
  if (unknown) text = text ? `${text} · unknown: ${unknown}` : `unknown: ${unknown}`;
  return { id: view.id, kind: "procedure", tags: ["howto", "procedure"], text, at: view.t, sal: 0 };
}

function isIclCue(text: string): boolean {
  try {
    // Official DetQA extract (`Now Answer the Question` + A./B./C./D. + trailing
    // `Output:`) is book-QA, not MCC. `label:` still wins overlap (M30.3).
    if (isBookQaCue(text) && !/\blabel\s*:/i.test(text)) return false;
    if (encodeLane(text) === "icl") return true;
    // Official MCC / store-all shots. Bare "label this PR" is chat, not ICL.
    if (isIclExemplar(text) || /\blabel\s*:/i.test(text)) return true;
  } catch {}
  return false;
}

/** MCC ingest is ICL-only; queries are the utterance after the template strips `label:`. */
function storeIsIclOnly(rows: { rec: { kind?: string; lane?: string; text?: string } }[]): boolean {
  try {
    const live = rows.filter((c) => c.rec.kind !== "digest");
    if (live.length < 4) return false;
    return live.every((c) => c.rec.lane === "icl" || isIclExemplar(String(c.rec.text ?? "")));
  } catch {
    return false;
  }
}

function isNarrativeNote(m: { lane?: string; tags?: string[] }): boolean {
  return m.lane === "narrative" || (m.tags ?? []).includes("chunk");
}

/**
 * Packet-only: drop superseded copulas from narrative notes using live SemanticStore.
 * Does not extract narrative as SF triples (M20.4 firewall). Fail-open: returns notes.
 */
function scrubNarrativeLeftovers<T extends { text: string; lane?: string; tags?: string[] }>(
  notes: T[],
  store: SemanticStore,
): T[] {
  try {
    if (!Array.isArray(notes)) return notes;
    const out: T[] = [];
    for (const n of notes) {
      if (!n || typeof n !== "object") continue;
      if (!isNarrativeNote(n) && n.lane !== "trajectory") {
        out.push(n);
        continue;
      }
      let next = String(n.text ?? "");
      try { next = omitConflictingIdentity(next, store); } catch { next = String(n.text ?? ""); }
      if (n.lane === "trajectory") {
        try { next = stripDeadObjects(next || String(n.text ?? ""), store); } catch {}
      }
      if (!next) {
        if (n.lane === "trajectory") out.push(n);
        continue;
      }
      out.push(next === n.text ? n : { ...n, text: next });
    }
    return out;
  } catch {
    return Array.isArray(notes) ? notes : [];
  }
}

/** Skip GraphRAG/CAR hops on ICL, recsys, summary, and book-QA cues. EventQA miller may still hop. */
function skipNarrativeComplete(mems: MemoryRecord[], cue: string): boolean {
  try {
    if (memoryLastRoute.route === "icl-index" || memoryLastRoute.route === "gist-chunk") return true;
    if (isIclCue(cue)) return true;
    if (isRecsysShot(cue)) return true;
    if (isSummaryCue(cue)) return true;
    if (isBookQaCue(cue)) return true;
    if (Array.isArray(mems) && mems.length && mems.every((m) => m.lane === "icl" || isIclExemplar(m.text))) return true;
  } catch {}
  return false;
}

/** Root SemanticStore row → chat fact. Not a second dir scheme.
 *  is → `The database is sqlite.` / `Auth is Clerk.` (proper object keeps a bare subject).
 *  uses → `stack uses sqlite`. Identifiers scrubbed. */
function rootIdentityText(s: string, p: string, o: string): string {
  let subj = String(s ?? "").trim();
  let obj = String(o ?? "").trim();
  const pred = String(p ?? "").trim().toLowerCase();
  if (!subj || !obj || !pred) return "";
  try {
    subj = scrubMemoryText(subj);
    obj = scrubMemoryText(obj);
  } catch {}
  if (!subj || !obj || subj === "[cwd]" || obj === "[cwd]" || subj === "[session]" || obj === "[session]" || subj === "[email]" || obj === "[email]") return "";
  if (pred === "uses") return `${subj} uses ${obj}`;
  const titled = subj.charAt(0).toUpperCase() + subj.slice(1);
  if (pred === "is") {
    // "Clerk" / "Alice" stayed capitalized on put. "sqlite" did not.
    if (/^[A-Z]/.test(obj)) return `${titled} is ${obj}.`;
    return `The ${subj} is ${obj}.`;
  }
  return `${titled} ${pred} ${obj}`.replace(/\s+/g, " ").trim();
}

function prependFloor(extras: MemoryRecord[], lexical: MemoryRecord[], cap: number): MemoryRecord[] {
  const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0)));
  if (!k || !extras.length) return lexical;
  extras.sort((a, b) => b.at - a.at);
  const base = Array.isArray(lexical) ? lexical : [];
  const out: MemoryRecord[] = [];
  const room = Math.max(k, 64);
  for (const r of extras) { if (out.length >= room) break; if (out.some((p) => p.id === r.id) || base.some((p) => p.id === r.id)) continue; out.push(r); }
  for (const l of base) { if (out.length >= room) break; if (out.some((p) => p.id === l.id)) continue; out.push(l); }
  return out.length ? out : base;
}

function mergeRootIdentity(lexical: MemoryRecord[], text: string, cap: number, dir: string): MemoryRecord[] {
  try {
    if (!String(text ?? "").trim()) return lexical;
    const live = new SemanticStore(dir).live();
    if (!Array.isArray(live) || !live.length) return lexical;
    const extras: MemoryRecord[] = [];
    for (const row of live) {
      const body = rootIdentityText(row.s, row.p, row.o);
      if (!body) continue;
      extras.push({
        id: `sem:${row.s}:${row.p}`,
        text: body,
        kind: "fact",
        lane: "chat",
        tags: ["fact", "semantic", "x-identity"],
        at: Number.isFinite(row.t) ? row.t : 0,
      });
    }
    return prependFloor(extras, lexical, cap);
  } catch {
    return lexical;
  }
}

function mergeLiveConstraints(lexical: MemoryRecord[], text: string, cap: number, rows: Compiled[]): MemoryRecord[] {
  try {
    if (!String(text ?? "").trim()) return lexical;
    return prependFloor(rows.filter((c) => c.rec.kind === "constraint").map((c) => c.rec), lexical, cap);
  } catch {
    return lexical;
  }
}

function mergeNarrativeLane(lexical: MemoryRecord[], text: string, cap: number, dir: string, compiled: MemoryRecord[] = []): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q) return lexical;
    if (isIclCue(q)) return lexical;
    const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0)));
    if (!k) return lexical;
    const hits = retrieveNarrativeChunks(dir, q, { k, fallback: compiled });
    const chat = Array.isArray(lexical) ? lexical.filter((l) => !isNarrativeNote(l)) : [];
    // Empty chunk hits: do not dump the store-all 4k pack (Clerk cue must not
    // surface miller/zebra). Chat facts stay. Throw still fail-opens to lexical.
    if (!Array.isArray(hits) || !hits.length) return chat;
    const chunks: MemoryRecord[] = [];
    for (const hit of hits) {
      const body = String(hit?.text ?? "").trim();
      if (!body) continue;
      const rec: MemoryRecord = {
        id: hit.id || `chunk:${hit.src || "anon"}:${chunks.length}`,
        text: body,
        kind: "episode",
        lane: "narrative",
        tags: ["chunk"],
        at: Number.isFinite(hit.t) ? hit.t : 0,
      };
      chunks.push(rec);
    }
    if (!chunks.length) return chat;
    const out: MemoryRecord[] = [];
    for (const c of chunks) {
      if (out.length >= cap) break;
      if (out.some((p) => p.id === c.id || jaccardText(p.text, c.text) > 0.6)) continue;
      out.push(c);
    }
    for (const l of chat) {
      if (out.length >= cap) break;
      if (out.some((p) => p.id === l.id || jaccardText(p.text, l.text) > 0.6)) continue;
      out.push(l);
    }
    return out;
  } catch {
    return lexical;
  }
}

function mergeIclLane(_lexical: MemoryRecord[], text: string, cap: number, dir: string, compiled: MemoryRecord[] = []): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q) return [];
    const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0)));
    if (!k) return [];
    const hits = retrieveIcl(dir, q, { k, fallback: compiled });
    if (!Array.isArray(hits) || !hits.length) return [];
    const out: MemoryRecord[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (out.length >= cap) break;
      const body = String(hit?.text ?? "").trim();
      if (!body) continue;
      const id = hit.id || `icl:${out.length}`;
      if (seen.has(id) || seen.has(body.toLowerCase())) continue;
      seen.add(id);
      seen.add(body.toLowerCase());
      const rec: MemoryRecord = {
        id,
        text: body,
        kind: "fact",
        lane: "icl",
        tags: ["icl"],
        at: Number.isFinite(hit.t) ? hit.t : 0,
      };
      out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

/** After lexical: fail-open howto merge. `dir` is howtoDir (memory root), never jsonlDir / session subdir. */
function mergeHowtoLane(lexical: MemoryRecord[], text: string, cap: number, dir: string): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q) return lexical;
    const views = retrieveHowTo(dir, q);
    if (!Array.isArray(views) || !views.length) return lexical;
    let harmed = new Set<string>();
    try { harmed = loadHarmedIds(dir); } catch { harmed = new Set(); }
    const scored: { view: (typeof views)[number]; n: number }[] = [];
    for (const view of views) {
      if (!view || typeof view !== "object") continue;
      try { if (view.id && harmed.has(view.id)) continue; } catch {}
      const n = howtoAboutness(q, view);
      if (n <= 0) continue;
      scored.push({ view, n });
    }
    if (!scored.length) return lexical;
    scored.sort((a, b) => b.n - a.n || (b.view.wins ?? 0) - (a.view.wins ?? 0) || b.view.t - a.view.t);
    const rec = howtoProcedureRecord(scored[0]!.view);
    const kept = lexical.filter((l) => l.id !== rec.id).slice(0, Math.max(0, cap - 1));
    return [...kept, rec];
  } catch {
    return lexical;
  }
}

/**
 * Extra trajectory slices on inject (M24). Chat k stays `cap` (6–10).
 * Empty cue → no dump (SessionStart stays pins+gists). Fail-open.
 * `dir` is memory root (howtoDir), never jsonlDir.
 */
function mergeExperienceLane(lexical: MemoryRecord[], text: string, dir: string): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q) return lexical;
    if (isIclCue(q)) return lexical;
    const hits = retrieveExperience(dir, q);
    if (!Array.isArray(hits) || !hits.length) return lexical;
    const extra: MemoryRecord[] = [];
    for (const hit of hits) {
      const body = String(hit?.text ?? "").trim();
      if (!body) continue;
      const rec: MemoryRecord = {
        id: `exp:${hit.id}`,
        text: body,
        kind: "episode",
        lane: "trajectory",
        tags: ["experience", "trajectory"],
        at: Number.isFinite(hit.t) ? hit.t : 0,
      };
      extra.push(rec);
    }
    if (!extra.length) return lexical;
    const out = lexical.slice();
    for (const e of extra) {
      if (out.some((p) => p.id === e.id || jaccardText(p.text, e.text) > 0.6)) continue;
      out.push(e);
    }
    return out;
  } catch {
    return lexical;
  }
}

/** Hierarchical extractive gists on summary / book-QA cues. Fail-open. k≤3. Gists then leftover chunks. */
function mergeGistLane(lexical: MemoryRecord[], text: string, cap: number, dir: string): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q) return lexical;
    if (isIclCue(q)) return lexical; // already gated, belt
    const hits = retrieveGists(dir, q, { k: Math.min(3, cap) });
    if (!hits.length) return lexical;
    const gists: MemoryRecord[] = hits.map(h => {
      const rec: MemoryRecord = {
        id: h.id || `gist:${h.level}:${h.t}`,
        text: h.text,
        kind: "gist",
        lane: "narrative",
        tags: ["gist"],
        at: h.t,
      };
      return rec;
    });
    const room = Math.max(0, cap - gists.length);
    let rest = (lexical||[]).filter(l => !gists.some(g => g.id===l.id || jaccardText(g.text,l.text)>0.6));
    try {
      rest = isBookQaCue(q) ? leftoverChunksForGists(rest, hits, dir, room) : rest.slice(0, room);
    } catch {
      rest = rest.slice(0, room);
    }
    return [...gists, ...rest].slice(0, cap);
  } catch { return lexical; }
}

export class AgentMemory {
  readonly dir: string;
  /** Sanitized session name. Child episodes use a `--` suffix; root stores stay on `dir`. */
  readonly session?: string;
  /** Child writer: episodic JSONL is the suffix file. Forget must not tombstone root unless the parent file already forgot. */
  readonly child: boolean;
  /** Directory of memories.jsonl (session subdir when session is set). Traces live here too. */
  get jsonlDir(): string {
    return dirname(this.path);
  }
  /**
   * How-to jsonl directory: always the memory root (`this.dir`), like semantic/gists.
   * Never the session jsonlDir. Wrap (no session) and hook (session_id) share one howto.jsonl.
   */
  get howtoDir(): string {
    return this.dir;
  }
  private know?: KnowSearch;
  private agent?: string;
  private project?: string;
  /** Raw session / cwd for scrub only — never written into JSONL. */
  private scrubSession?: string;
  private scrubCwd?: string;
  private compiled: Compiled[];
  private path: string;
  /** Fingerprints of the last observed message window (the hook re-sends a sliding 40-message window). */
  private lastWin: string[] = [];
  /** Hippocampal write buffer: coalesce JSONL flushes across one observe()/episode. */
  private batch = 0;
  private dirty = false;
  /** Record ids already durable on JSONL+WAL. New/updated ids append to WAL until compact. */
  private durableIds = new Set<string>();
  /** Ids that must be WAL-appended (or compacted) on next persist. */
  private walDirtyIds = new Set<string>();
  /** Explicit removals that must survive a concurrent-WAL merge during compact. */
  private deletedIds = new Set<string>();
  /** Drop/rewrite/eviction/close: rewrite JSONL snapshot and truncate WAL. */
  private needCompact = false;
  private sem?: SemanticStore;
  /** Lowercased texts in the active project — O(1) observe dup skip (same set as linear scan). */
  private seenLower = new Set<string>();

  constructor(opts: MemoryOptions = {}) {
    this.know = opts.know; this.agent = opts.agent; this.project = opaqueProject(opts.project);
    this.scrubSession = typeof opts.session === "string" && opts.session ? opts.session : undefined;
    const cwdOpt = typeof opts.cwd === "string" && opts.cwd.trim() ? opts.cwd.trim() : undefined;
    const proj = typeof opts.project === "string" && opts.project.trim() ? opts.project.trim() : undefined;
    this.scrubCwd = cwdOpt || (proj && (proj.includes("/") || proj.includes("\\") || /^[A-Za-z]:/.test(proj)) ? proj : undefined);
    mkdirSync((this.dir = opts.dir || join(homedir(), ".eden", "memory")), { recursive: true });
    try { chmodSync(this.dir, 0o700); } catch {}
    const session = memorySessionName(opts.session);
    this.session = session;
    // Forget / prune follow this flag only. A parent id that happens to contain
    // `--` (childSessionName's suffix) is still a parent unless the caller sets child.
    this.child = opts.child === true;
    if (session) {
      const sub = join(this.dir, session);
      mkdirSync(sub, { recursive: true });
      try { chmodSync(sub, 0o700); } catch {}
      this.path = join(sub, "memories.jsonl");
    } else {
      this.path = join(this.dir, "memories.jsonl");
    }
    this.compiled = load(this.path);
    this.durableIds = new Set(this.compiled.map((c) => c.rec.id));
    this.rebuildSeen();
    try { migrateSessionHowTo(this); } catch {}
  }

  memories(): MemoryRecord[] {
    return this.compiled.map((c) => c.rec).filter((r) => !this.project || r.project === this.project);
  }

  /** Redact secrets + strip session/email/cwd before compile/persist. Never throws. */
  private persistText(text: string): string {
    let t = String(text ?? "");
    try {
      t = t.replace(SECRET_INLINE, "[REDACTED]");
    } catch {}
    try {
      const redacted = redact(t);
      if (typeof redacted === "string") t = redacted;
    } catch {}
    try {
      // IR redact is key=value only — "password is hunter2" would otherwise persist.
      // Do not use "auth is" / "token is": those eat Clerk facts and ordinary speech.
      t = t.replace(
        /\b((?:passwords?|passwd|passphrase|api[_-]?keys?)\s*(?:=|:|is)\s+)[^\s,.;]+/gi,
        "$1[REDACTED]",
      );
    } catch {}
    try {
      t = scrubMemoryText(t, { session: this.scrubSession, cwd: this.scrubCwd });
    } catch {}
    return t;
  }

  remember(text: string, opts: { kind?: MemoryKind; tags?: string[]; id?: string; agent?: string; project?: string; sal?: number; pin?: boolean; lane?: MemoryLaneKind } = {}): MemoryRecord {
    const rec: MemoryRecord = { id: opts.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, text: this.persistText(String(text || "").trim()), kind: opts.kind || "fact", tags: (opts.tags || []).map((t) => t.toLowerCase()), agent: opts.agent || this.agent, project: opaqueProject(opts.project || this.project), at: Date.now(), lane: opts.lane ?? "chat" };
    if (!rec.text) return rec;
    try { if (memoryConsent() !== "on") return rec; } catch { return rec; }
    const uttered = `${text ?? ""}\n${rec.text}`;
    const pin = opts.pin === true || isPinUtterance(uttered);
    let sal = opts.sal ?? salience(rec.text);
    if (pin) {
      sal = Math.max(sal, opts.pin === true || /\b(?:always|remember)\b/i.test(uttered) ? 1 : 0.6);
      if (!rec.tags.includes("pin")) rec.tags.push("pin");
    }
    if (sal > 0) rec.sal = sal;
    const c = compile(rec), i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    i >= 0 && this.compiled.splice(i, 1);
    this.compiled.push(c);
    this.walDirtyIds.add(rec.id);
    if (!this.project || rec.project === this.project) this.seenLower.add(rec.text.toLowerCase());
    return this.flush(true), rec;
  }

  private semantic(): SemanticStore {
    return (this.sem ??= new SemanticStore(this.dir));
  }

  private rebuildSeen() {
    this.seenLower = new Set();
    for (const c of this.compiled) {
      if (!this.project || c.rec.project === this.project) this.seenLower.add(c.rec.text.toLowerCase());
    }
  }

  /**
   * Observe a message list. The CLI hook re-sends a sliding window of the last 40 turns after every
   * assistant turn, so messages are matched against the previous window and only the new tail is processed.
   */
  observe(messages: unknown[], opts: { keepLiveIdentity?: boolean; deferSleep?: boolean } = {}): MemoryRecord[] {
    try { if (memoryConsent() !== "on") return []; } catch { return []; }
    this.batch++;
    try {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => (m && typeof m === "object" ? (m as { role?: string }).role : "") !== "system");
    const out: MemoryRecord[] = [];
    const items = list.map((m) => ({ role: String((m && typeof m === "object" ? (m as { role?: string }).role : "") || "user"), text: convBlob([m]).trim().replace(/\s+/g, " ") })).filter((i) => i.text);
    const fps = items.map((i) => `${i.role}${i.text.slice(0, 400)}`);
    let start = 0;
    if (this.lastWin.length && fps.length) {
      let found = -1;
      for (let k = 0; k < this.lastWin.length && found < 0; k++) {
        const len = Math.min(this.lastWin.length - k, fps.length);
        let ok = true;
        for (let i = 0; i < len; i++) if (this.lastWin[k + i] !== fps[i]) { ok = false; break; }
        if (ok) found = len;
      }
      if (found >= 0) start = found;
    }
    if (fps.length) this.lastWin = fps.slice(-80);
    let sem: SemanticStore | undefined;
    // Facts asserted in this observe. A later sentence may replace them.
    // keepLiveIdentity still refuses to clobber a value already on disk.
    const batchLive = new Map<string, string>();
    for (let i = start; i < items.length; i++) {
      const it = items[i]!;
      const safe = this.persistText(it.text);
      const lane = encodeLane(it.text);
      if (lane === "icl" || lane === "narrative") {
        let text = safe;
        if (lane === "narrative" && opts.keepLiveIdentity) {
          try { text = omitConflictingIdentity(text, this.semantic()); } catch {}
        }
        if (text && !this.seenLower.has(text.toLowerCase())) {
          const tags = tokList(text).concat([lane]);
          try { if (isRecsysShot(it.text)) tags.push("recsys"); } catch {}
          const rec = this.remember(text, {
            kind: lane === "narrative" ? "episode" : "fact",
            lane,
            tags,
            sal: salience(text),
          });
          out.push(rec);
          if (lane === "narrative") {
            try { new ChunkStore(this.dir).put(text, { src: rec.id, t: rec.at }); } catch {}
          }
          if (lane === "icl") {
            try { new IclIndex(this.dir).put(text, { src: rec.id, t: rec.at }); } catch {}
          }
        }
        continue;
      }
      let forgot = false;
      try { forgot = applyObserveForget(this, it.role, safe); } catch { forgot = false; }
      if (forgot) continue;
      for (const raw of extractDurable(safe)) {
        let text = raw;
        try {
          const asserted = observeAsserted(text);
          if (asserted && /\b(?:instead of|rather than)\b/i.test(text)) {
            text = asserted.p === "uses" ? `Use ${asserted.o}.` : `The ${asserted.s} is ${asserted.o}.`;
          }
        } catch {}
        const extraTags = ([[/\bpull requests?\b/i, "pr"], [/\btimezone|pacific|utc\b/i, "tz"], [/@[\w.-]+\.[a-z]{2,}/i, "email"], [/\b(vegetarian|vegan|pescatarian|skip dairy|lactose|allerg|kosher|halal|gluten)\b/i, "diet"]] as const).flatMap(([re, t]) => re.test(text) ? [t] : []);
        text = this.persistText(text);
        try {
          const fact = observeAsserted(text);
          if (fact && (isIclExemplar(raw) || isIclExemplar(it.text))) continue;
          if (fact) {
            const store = (sem ??= this.semantic());
            const live = store.get(fact.s, fact.p);
            if (opts.keepLiveIdentity) {
              const obj = fact.o.trim().toLowerCase();
              const slot = `${fact.s}\0${fact.p}`;
              const fromBatch = batchLive.get(slot);
              // Same transcript: postgres then sqlite. The later line wins.
              // A stale replay must not replace a different object already stored.
              if (!(fromBatch && fromBatch !== obj)) {
                if (live && live.o.trim().toLowerCase() !== obj) continue;
                if (store.supersededObject(fact.o)) continue;
              }
            }
            const serial = String(text).trim().match(/^(\d+)[.)]\s+\S/);
            const serialT = serial && Number.isFinite(Number(serial[1])) ? Number(serial[1]) : undefined;
            if (serialT == null && live && live.t < 1e11 && !batchLive.has(`${fact.s}\0${fact.p}`)) {
              // Unnumbered wall-clock must not outrank a live serial.
            } else {
              store.put(fact.s, fact.p, fact.o, serialT ?? Date.now());
              batchLive.set(`${fact.s}\0${fact.p}`, fact.o.trim().toLowerCase());
            }
          }
        } catch {}
        if (this.seenLower.has(text.toLowerCase())) continue;
        const key = subjectKey(text);
        // "instead of" / "rather than" stays in JSONL until full sleep. Incremental
        // rest must not drop a fact the open goal still references.
        const supersede = /\b(?:instead of|rather than)\b/i.test(raw);
        if (key && !supersede) {
          let removed = false;
          for (const c of this.compiled) {
            if ((!this.project || c.rec.project === this.project) && subjectKey(c.rec.text) === key) {
              this.deletedIds.add(c.rec.id);
              removed = true;
            }
          }
          if (removed) {
            this.compiled = this.compiled.filter((c) => (this.project && c.rec.project !== this.project) || subjectKey(c.rec.text) !== key);
            this.needCompact = true;
            this.rebuildSeen();
          }
        }
        const pin = isPinUtterance(safe) || isPinUtterance(it.text);
        out.push(this.remember(text, { kind: pin ? "constraint" : /\b(prefer|never |always |don'?t |do not |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b/i.test(text) ? "episode" : "fact", lane: "chat", tags: tokList(text).concat(extraTags), sal: pin ? Math.max(0.6, salience(text)) : salience(text), pin }));
      }
    }
    if (items.length) {
      const goalRaw = [...items].reverse().find((i) => i.role === "user")?.text ?? "";
      let goal = goalRaw;
      try { goal = this.persistText(goalRaw); } catch {}
      const bytes = items.reduce((n, i) => n + i.text.length, 0);
      try { noteSleepActivity(this, { turns: 1, bytes, goal }); } catch {}
      if (opts.deferSleep !== true) {
        try { scheduleIncrementalSleep(this); } catch {}
      }
    }
    return out;
    } finally {
      this.batch--;
      this.flush(false);
    }
  }

  private flush(mark: boolean) {
    if (mark) this.dirty = true;
    if (this.batch || !this.dirty) return;
    this.persist();
  }

  private persist() {
    try { if (memoryConsent() !== "on") return; } catch { return; }
    const cap = storeCap();
    const wal = memoryWalPath(this.path);
    try {
      withFileLock(`${this.path}.lock`, () => {
        let pending = this.compiled.filter((c) => this.walDirtyIds.has(c.rec.id));
        const walN = walLineCount(wal);
        let snapshotMissing = false;
        try { snapshotMissing = !existsSync(this.path); } catch { snapshotMissing = true; }
        let compact = this.needCompact || snapshotMissing || this.compiled.length > cap || walN + pending.length >= MEMORY_WAL_COMPACT_LINES;
        if (compact) {
          // Re-read under the lock: this instance may predate another writer's WAL.
          // Local dirty ids win, explicit local removals remain removed.
          const disk = load(this.path);
          const local = new Map(this.compiled.map((c) => [c.rec.id, c] as const));
          const merged: Compiled[] = [];
          const seen = new Set<string>();
          for (const c of disk) {
            const id = c.rec.id;
            if (this.deletedIds.has(id) || seen.has(id)) continue;
            merged.push(this.walDirtyIds.has(id) ? (local.get(id) ?? c) : c);
            seen.add(id);
          }
          for (const c of this.compiled) {
            if (this.deletedIds.has(c.rec.id) || seen.has(c.rec.id)) continue;
            merged.push(c);
            seen.add(c.rec.id);
          }
          this.compiled = merged;
        }
        let evicted = false;
        if (this.compiled.length > cap) {
          const pin = (c: Compiled) => c.rec.kind === "constraint" || (c.rec.sal ?? 0) >= 0.6 || (c.rec.tags ?? []).includes("pin");
          const laneOf = (c: Compiled) => c.rec.lane || "chat";
          const durableLane = (c: Compiled) => laneOf(c) === "icl" || laneOf(c) === "narrative";
          const pins = this.compiled.filter(pin).sort((a, b) => a.rec.at - b.rec.at).slice(-cap);
          const durable = this.compiled.filter((c) => !pin(c) && durableLane(c)).sort((a, b) => a.rec.at - b.rec.at);
          const chat = this.compiled.filter((c) => !pin(c) && !durableLane(c)).sort((a, b) => a.rec.at - b.rec.at);
          let room = cap - pins.length;
          const keepDurable = durable.slice(Math.max(0, durable.length - room));
          room = cap - pins.length - keepDurable.length;
          const keepChat = chat.slice(Math.max(0, chat.length - room));
          const kept = new Set([...pins, ...keepDurable, ...keepChat].map((c) => c.rec.id));
          for (const c of this.compiled) if (!kept.has(c.rec.id)) this.deletedIds.add(c.rec.id);
          this.compiled = [...pins, ...keepDurable, ...keepChat];
          this.rebuildSeen();
          evicted = true;
        }
        pending = this.compiled.filter((c) => this.walDirtyIds.has(c.rec.id));
        compact = compact || evicted;
        if (compact) {
          writeFileAtomic(this.path, this.compiled.map((x) => JSON.stringify(x.rec)).join("\n") + (this.compiled.length ? "\n" : ""));
          try { chmodSync(this.path, 0o600); } catch {}
          try { unlinkSync(wal); } catch {}
          this.durableIds = new Set(this.compiled.map((c) => c.rec.id));
          this.walDirtyIds.clear();
          this.deletedIds.clear();
          this.needCompact = false;
        } else if (pending.length) {
          const lines = (rows: Compiled[]) => rows.map((c) => JSON.stringify(c.rec)).join("\n") + "\n";
          appendJsonl(wal, lines(pending));
          try { chmodSync(wal, 0o600); } catch {}
          // Fresh ids also append onto memories.jsonl. Hook spawns never close(),
          // and load replaces these same ids from the WAL so the store does not double.
          const fresh = pending.filter((c) => !this.durableIds.has(c.rec.id));
          if (fresh.length) {
            appendJsonl(this.path, lines(fresh));
            try { chmodSync(this.path, 0o600); } catch {}
          }
          for (const c of pending) this.durableIds.add(c.rec.id);
          this.walDirtyIds.clear();
        }
      });
      this.dirty = false;
    } catch {
      // Keep dirty so a later flush retries. A lock/disk fault must not throw into inject.
    }
  }

  relevant(text: string, cap = memoryRetrieveCap()): MemoryRecord[] {
    let route: MemoryRoute = "chat-jsonl";
    try { route = routeMemory(text); } catch { route = "chat-jsonl"; }
    try { if (storeIsIclOnly(this.compiled)) route = "icl-index"; } catch {}
    memoryLastRoute.route = route;
    const recs = this.compiled.map((c) => c.rec);
    if (route === "icl-index") {
      // Second pass keeps unique labels (gold label: 7 stays). Same-label clones collapse.
      return suppressPacketNearDups(mergeIclLane([], text, cap, this.howtoDir, recs));
    }
    if (route === "gist-chunk") {
      return suppressPacketNearDups(mergeGistLane(mergeNarrativeLane([], text, cap, this.howtoDir, recs), text, cap, this.howtoDir));
    }
    const hay = queryHay(text);
    const rows = this.compiled.filter((c) => c.rec.kind !== "digest" && c.rec.lane !== "icl" && !isIclExemplar(c.rec.text) && !(this.agent && c.rec.agent && c.rec.agent !== this.agent) && !(this.project && c.rec.project !== this.project));
    const scored: { rec: MemoryRecord; n: number }[] = [];
    for (const c of rows) {
      let n = 0;
      const seen = new Set<string>();
      for (const x of c.needles) {
        if (!hay.has(x) || seen.has(x)) continue;
        seen.add(x);
        n++;
      }
      if (n) scored.push({ rec: c.rec, n });
    }
    const ranked = scored.sort((a, b) => b.n - a.n || Number(b.rec.kind === "constraint") - Number(a.rec.kind === "constraint") || b.rec.at - a.rec.at).slice(0, Math.max(cap * 6, 30));
    let lexical = dedupSelect(ranked, cap);
    lexical = mergeLiveConstraints(lexical, text, cap, rows);
    lexical = mergeRootIdentity(lexical, text, cap, this.dir);
    return suppressPacketNearDups(mergeExperienceLane(
      mergeHowtoLane(mergeNarrativeLane(lexical, text, cap, this.howtoDir, recs), text, cap, this.howtoDir),
      text,
      this.howtoDir,
    ));
  }

  notesFor(text = "", k = memoryRetrieveCap()): MemoryRecord[] {
    if (text) {
      const pool = Math.min(18, Math.max(Math.floor(Number(k) || 0), 12));
      const recs = this.relevant(text, pool);
      const mixed = fatPacket(recs, k).map(formatNote);
      try { return dropHarmed(this.dir, mixed); } catch { return mixed; }
    }
    const recs = this.memories().filter((r) => !isNarrativeNote(r) && r.lane !== "icl" && r.lane !== "trajectory");
    const emptyCue = ((rows) => [...rows.filter((r) => r.kind === "constraint").slice(-k), ...rows.filter((r) => r.kind !== "constraint").slice(-k)].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i).slice(0, k))(recs).map(formatNote);
    try { return dropHarmed(this.dir, emptyCue); } catch { return emptyCue; }
  }

  /** Omit these ids on later inject. Root `this.dir` (shared with howto). Write no-op unless consent is on. */
  markHarmed(ids: Iterable<string>): void {
    try { persistHarmed(this.dir, ids); } catch {}
  }

  inject(messages: unknown[], extraPaths?: Iterable<string>): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      try { if (memoryConsent() === "off") return list; } catch { return list; }
      const blob = convBlob(list);
      const notes: { role: "system"; content: string }[] = [];
      if (!alreadyInjected(blob) && !blob.includes(MEMORY_MARK)) {
        const cue = cueFor(list);
        let rankCue = cue;
        try {
          const fromMsg = placePathsFrom(lastUserMessage(list));
          const extra: string[] = [];
          if (extraPaths) for (const p of extraPaths) if (typeof p === "string") extra.push(p);
          rankCue = cue ? attachPlaceCues(cue, extra.length ? [...fromMsg, ...extra] : fromMsg) : "";
        } catch {
          rankCue = cue;
        }
        // Hop-enrich retrieved notes, then assemble (loser-scrub / live winner), then
        // complete again so last hop is first among facts. Fail-open. EventQA / ICL
        // skip complete() — those lanes are not a hop graph (skipNarrativeComplete).
        const retrieved = rankCue ? this.notesFor(rankCue) : [];
        let silent = false;
        if (rankCue && retrieved.length) {
          try {
            if (isMathChatterCue(rankCue)) {
              memoryInjectSilent.n++;
              silent = true;
            }
          } catch {}
        }
        let packet: MemoryRecord[] = [];
        try {
          let hopped = silent ? [] : retrieved;
          if (!silent && rankCue && retrieved.length && !skipNarrativeComplete(retrieved, rankCue)) {
            const hopStore = (() => {
              const out: MemoryRecord[] = [];
              const seen = new Set<string>();
              const push = (m: MemoryRecord | { id?: string; text?: string; lane?: string; kind?: string; at?: number; tags?: string[] }) => {
                try {
                  const text = String(m?.text ?? "").trim();
                  if (!text) return;
                  if ((m as { lane?: string }).lane === "icl" || isIclExemplar(text)) return;
                  // Do not drop a 512-token wiki chunk because some sentence has `?`.
                  // extractTriple already rejects interrogative sentences after expandHopRows.
                  const id = String((m as { id?: string }).id ?? "") || `hop:${text.slice(0, 48)}`;
                  if (seen.has(id) || seen.has(text.slice(0, 96))) return;
                  seen.add(id);
                  seen.add(text.slice(0, 96));
                  out.push(m as MemoryRecord);
                } catch {}
              };
              for (const r of retrieved) push(r);
              try {
                for (const c of new ChunkStore(this.howtoDir).all()) {
                  push({
                    id: c.id,
                    text: c.text,
                    kind: "episode",
                    lane: "narrative",
                    tags: ["chunk"],
                    at: c.t,
                  } as MemoryRecord);
                }
              } catch {}
              try {
                for (const m of this.memories()) {
                  // Store-all novels stay out of the hop graph; 512-token chunks come from ChunkStore/retrieved.
                  if (isNarrativeNote(m) && !(m.tags ?? []).includes("chunk")) continue;
                  push(m);
                }
              } catch {}
              return out;
            })();
            let hopPool = hopStore;
            try { hopPool = dropHarmed(this.dir, hopStore); } catch { hopPool = hopStore; }
            hopped = completeNotes(rankCue, retrieved, hopPool);
            packet = hopped.length ? assembleNotes(hopped, this.dir) : [];
            // Walk the full hop graph so a 3-hop last fact stays first, but do
            // not pull store rows assemble just scrubbed (serial vs wall-clock).
            packet = completeNotes(rankCue, packet, hopPool, { pull: false });
          } else {
            packet = hopped.length ? assembleNotes(hopped, this.dir) : [];
          }
        } catch {
          packet = !silent && retrieved.length ? assembleNotes(retrieved, this.dir) : [];
        }
        // Packet-only leftover identity (miller+Alice). Not SF extract — M20.4 assembleNotes keeps the note.
        try { if (rankCue && !silent) packet = scrubNarrativeLeftovers(packet, this.semantic()); } catch {}
        packet = packet.map(formatNote);
        try { packet = dropHarmed(this.dir, packet); } catch {}
        // Ids + ages on stderr only. Empty packet (M38 omit) logs nothing and adds no mark.
        try { logMemoryNotes(packet); } catch {}
        if (packet.length) notes.push({ role: "system", content: MEMORY_MARK + packet.map((m) => `\n- ${m.text}`).join("") });
        const card = injectFromRequest({ text: blob }, this.know); if (card) notes.push({ role: "system", content: injectNote(card) });
      }
      this.observe(list, { deferSleep: true });
      try { scheduleIncrementalSleep(this); } catch {}
      if (!notes.length) return list;
      const next = list.slice(), i = next.findIndex((m) => (m as { role?: string })?.role !== "system");
      return next.splice(i < 0 ? next.length : i, 0, ...notes), next;
    } catch {
      memoryInjectSwallows.n++;
      // Fail-open: retrieveExperience throw is caught in mergeExperienceLane; this catch stays pass-through.
      if (process.env.EDEN_MEMORY_SWALLOW === "1") console.error("eden-memory inject swallow", memoryInjectSwallows.n);
      return list;
    }
  }

  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    try { if (memoryConsent() === "off") return body; } catch { return body; }
    const key = Array.isArray(body.messages) ? "messages" : Array.isArray(body.contents) ? "contents" : "messages", m = Array.isArray(body[key]) ? (body[key] as unknown[]) : [], sys = body.systemInstruction ?? body.system_instruction ?? body.system ?? body.system_prompt ?? body.systemPrompt;
    try {
      const sysBlob = typeof sys === "string" ? sys : sys ? convBlob(Array.isArray(sys) ? sys : [sys]) : "";
      // Rank/encode messages first. system* is this-request text: encode after retrieve so it cannot echo as memory.
      // Skip-if-mark: MEMORY_MARK already in systemInstruction must not add a second packet into contents/messages.
      // Body path headers rank via extraPaths. They are not copied onto the last user message.
      // Skip-if-mark still observes the original messages. Silent identity returns `body`.
      let extra: string[] = [];
      try { extra = placePathsFrom(body); } catch { extra = []; }
      const next = alreadyInjected(sysBlob) || sysBlob.includes(MEMORY_MARK) ? (this.observe(m), m) : this.inject(m, extra);
      if (sys) this.observe(typeof sys === "string" ? [{ role: "user", content: sys }] : [sys], { keepLiveIdentity: true });
      if (next === m) return body;
      return stripWrapPlaceFields({ ...body, [key]: next });
    } catch {
      memoryInjectSwallows.n++;
      // Fail-open: experience retrieve miss/throw does not 500 the wrap body.
      if (process.env.EDEN_MEMORY_SWALLOW === "1") console.error("eden-memory inject swallow", memoryInjectSwallows.n);
      return body;
    }
  }
  /** One JSONL flush after many observes (CLS session ingest = massed hippocampal write). */
  quiet(fn: () => void) {
    this.batch++;
    const sem = this.semantic();
    sem.beginBatch();
    try { fn(); } finally {
      try { sem.endBatch(); } catch {}
      this.batch--;
      this.flush(false);
    }
  }

  dropWhere(pred: (r: MemoryRecord) => boolean): void {
    for (const c of this.compiled) if (pred(c.rec)) this.deletedIds.add(c.rec.id);
    this.compiled = this.compiled.filter((c) => !pred(c.rec));
    this.needCompact = true;
    this.flush(true);
  }

  rewriteWhere(pred: (r: MemoryRecord) => string | undefined): void {
    let dirty = false;
    this.compiled = this.compiled.map((c) => {
      const next = pred(c.rec);
      if (typeof next !== "string" || next === c.rec.text) return c;
      dirty = true;
      this.walDirtyIds.add(c.rec.id);
      this.needCompact = true;
      return compile({ ...c.rec, text: next });
    });
    if (dirty) this.flush(true);
  }

  async sleep(opts?: { session?: string }): Promise<void> {
    try { if (memoryConsent() !== "on") return; } catch { return; }
    try { consolidate(this, opts); } catch {}
  }

  close() {
    try { clearSleepTimer(this); } catch {}
    try { if (existsSync(memoryWalPath(this.path))) this.needCompact = true; } catch {}
    if (this.needCompact) this.dirty = true;
    this.flush(false);
  }
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

let proc: AgentMemory | undefined;

/**
 * Wrap singleton. No env → root jsonl (`jsonlDir === dir`).
 * `EDEN_MEMORY_SESSION` or `EDEN_MEMORY_PARENT` is the parent session.
 * `EDEN_MEMORY_CHILD` suffixes that name and sets `child`. Same `dir` (root stores).
 * A live proc with a different dir or session is closed and reopened.
 */
export function processMemory(): AgentMemory {
  if (process.argv.some((a) => a.endsWith(".test.ts"))) {
    return openMemory({ dir: join(tmpdir(), "eden-m-" + Math.random().toString(36).slice(2)) });
  }
  const dir = process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined);
  const root = dir || join(homedir(), ".eden", "memory");
  let session: string | undefined;
  let child = false;
  try {
    const parent = memorySessionName(process.env.EDEN_MEMORY_SESSION) ?? memorySessionName(process.env.EDEN_MEMORY_PARENT);
    const childId = memorySessionName(process.env.EDEN_MEMORY_CHILD);
    if (childId) {
      session = childSessionName(parent, childId);
      child = true;
    } else {
      session = parent;
    }
  } catch {
    session = undefined;
    child = false;
  }
  if (proc && (proc.dir !== root || proc.session !== session || proc.child !== child)) {
    try { proc.close(); } catch {}
    proc = undefined;
  }
  return (proc ??= openMemory({
    dir,
    agent: process.env.EDEN_MEMORY_AGENT || undefined,
    project: process.env.EDEN_MEMORY_PROJECT || undefined,
    session,
    child,
  }));
}

export { sleep, consolidate, maybeIncrementalSleep, scheduleIncrementalSleep, flushIncrementalSleep, parseSleepEvery, sleepIdleMs, sleepBudgetMs } from "./sleep";

