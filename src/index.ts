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
import { retrieveExperience } from "./experience-retrieve";
import { retrieveNarrativeChunks } from "./chunk-retrieve";
import { retrieveGists, isSummaryCue, isBookQaCue, leftoverChunksForGists, GIST_CHAR_CAP } from "./gist-retrieve";
import { ChunkStore } from "./chunk-store";
import { IclIndex, retrieveIcl } from "./icl-index";
import { opaqueProject, scrubMemoryText } from "./memory-scrub";
import { type MemoryLaneKind } from "./memory-lanes";
import { logMemoryNotes } from "./memory-log";
import { applyProvenanceLabel, noteKindToken, stripPacketLabel } from "./memory-provenance";
import { routeMemory, type MemoryRoute } from "./memory-router";
import { isIclExemplar, isRecsysShot, isToolProse, objectAsserted, SemanticStore } from "./semantic-store";

export { dropHarmed, loadHarmedIds, markHarmed } from "./memory-harmed";
export const MEMORY_MARK = "Eden Memory:";
export const memoryInjectSwallows = { n: 0 };
export const memoryInjectSilent = { n: 0 };
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

export type MemoryKind = "fact" | "preference" | "episode" | "procedure" | "constraint" | string;
export type MemoryRecord = { id: string; text: string; kind: MemoryKind; tags: string[]; agent?: string; project?: string; at: number; ep?: string; ctx?: Record<string, number>; sal?: number; lane?: MemoryLaneKind };
function memRec(id: string, text: string, kind: MemoryKind, lane: MemoryLaneKind, tags: string[], at: number): MemoryRecord {
  return { id, text, kind, lane, tags, at };
}
export type KnowSearch = { search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[]; close?: () => void };
export type MemoryOptions = { dir?: string; know?: KnowSearch; agent?: string; project?: string; session?: string; cwd?: string; child?: boolean };

export function memorySessionName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s || s.includes("\0") || s.includes("/") || s.includes("\\")) return undefined;
  if (s.split("--").join("").includes("..")) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") return undefined;
  return s;
}

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

type Compiled = { rec: MemoryRecord; needles: string[] };

const STOP = new Set(["the","of","is","a","an","on","to","and","in","for","this","that","with","from","into","about","these","then","still","has","out","please","how","should","what","why","was","are","you","your","its","our","not","never","use","used","just","last","week","down","look","next","need","before","merge","prefers","user","memory","ran","fact","such","or","no","app"]);

const NEAR_DUP_J = 0.8;

function dedupSelect<T extends { rec: MemoryRecord; n: number }>(pool: T[], cap: number): MemoryRecord[] {
  try {
    const limit = Math.floor(Number(cap));
    if (!Number.isFinite(limit) || limit <= 0 || !pool.length) return [];
    const picked: T[] = [];
    const lanes: string[] = [];
    const stems: Set<string>[] = [];
    for (const cand of pool) {
      if (picked.length >= limit) break;
      let lane = "chat";
      try {
        const rec = cand.rec;
        const text = String(rec?.text ?? "");
        if (rec?.lane === "icl" || isIclExemplar(text)) lane = "icl";
        else if (rec?.kind === "procedure") lane = "procedure";
        else if (rec?.lane === "trajectory") lane = "trajectory";
        else if (rec?.kind === "gist" || rec?.kind === "digest") lane = "gist";
        else if (rec?.lane === "narrative") lane = "narrative";
      } catch {}
      const bagAll = new Set<string>();
      const bagContent = new Set<string>();
      try {
        for (const w of (s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(String(cand.rec.text ?? ""))) {
          if (!w) continue;
          bagAll.add(w);
          if (!STOP.has(w)) bagContent.add(w);
        }
      } catch {}
      const bag = bagContent.size ? bagContent : bagAll;
      let dup = false;
      for (let i = 0; i < picked.length; i++) {
        if (lanes[i] !== lane) continue;
        let la = "";
        let lb = "";
        try {
          const ma = String(cand.rec?.text ?? "").match(/\blabel\s*:\s*(\S+)/i);
          if (ma?.[1]) la = ma[1].replace(/[.,;:!?]+$/g, "").trim().toLowerCase();
          const mb = String(picked[i]!.rec?.text ?? "").match(/\blabel\s*:\s*(\S+)/i);
          if (mb?.[1]) lb = mb[1].replace(/[.,;:!?]+$/g, "").trim().toLowerCase();
        } catch {}
        if (la && lb && la !== lb) continue;
        const other = stems[i]!;
        if (bag.size && other.size) {
          let inter = 0;
          for (const w of bag) if (other.has(w)) inter++;
          const uni = bag.size + other.size - inter;
          if (uni && inter / uni >= NEAR_DUP_J) { dup = true; break; }
        }
      }
      if (dup) continue;
      picked.push(cand);
      lanes.push(lane);
      stems.push(bag);
    }
    return picked.map((x) => x.rec);
  } catch {
    return pool.slice(0, ((n) => (Number.isFinite(n) && n > 0 ? n : 0))(Math.floor(Number(cap)))).map((x) => x.rec);
  }
}

export function queryHay(text: string): Set<string> {
  return new Set((s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(text));
}

const TOOL_ROLES = new Set(["tool", "function"]);
const TOOL_BLOCKS = new Set(["tool_result", "tool_use", "function_call", "function_result"]);

function convBlob(list: unknown[]): string {
  if (list.length === 1) {
    const o = list[0] as Record<string, unknown> | undefined;
    const role = String(o?.role ?? "").toLowerCase();
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

export function cueFor(list: unknown[]): string {
  const m = Array.isArray(list) ? list.findLast((x) => { if (!x || typeof x !== "object") return false; const role = String((x as { role?: unknown }).role ?? "").toLowerCase(); if (role === "system") return false; const text = convBlob([x]).trim(); return !!text && !text.startsWith(MEMORY_MARK) && (role === "user" || role === "human"); }) : undefined;
  return m && typeof m === "object" ? convBlob([m]).trim() : "";
}

const PLACE_PATH_KEYS = ["open_files", "openFiles", "files", "file_paths", "filePaths", "file_path", "filePath", "path", "filename", "file", "recently_viewed_files", "recentlyViewedFiles"] as const;
const PLACE_GOAL_KEYS = ["last_goal", "lastGoal", "current_goal", "currentGoal"] as const;
const PLACE_OBJ_KEYS = ["path", "file_path", "filePath", "filename", "uri", "name"] as const;
const PLACE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PLACE_DOTTED = /^[A-Za-z0-9_-]+(?:\.[A-Za-z][A-Za-z0-9]*)+$/;
const PLACE_SEG = /^[A-Za-z0-9_.@+-]+$/;
const PLACE_CAP = 8;

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
    if (PLACE_DOTTED.test(base)) ((out, name) => { const n = name.trim(); if (!n || n.length > 120 || /[\r\n]/.test(n) || PLACE_EMAIL.test(n)) return; const key = n.toLowerCase(); if (out.some((x) => x.toLowerCase() === key) || out.length >= PLACE_CAP) return; out.push(n); })(out, base);
    return;
  }
  const parts = s.split("/").filter(Boolean);
  if (!parts.length || !parts.every((p) => PLACE_SEG.test(p)) || !PLACE_DOTTED.test(parts[parts.length - 1] ?? "")) return;
  const base = parts[parts.length - 1] ?? "";
  ((out, name) => { const n = name.trim(); if (!n || n.length > 120 || /[\r\n]/.test(n) || PLACE_EMAIL.test(n)) return; const key = n.toLowerCase(); if (out.some((x) => x.toLowerCase() === key) || out.length >= PLACE_CAP) return; out.push(n); })(out, base);
  if (s.length <= 120 && s.includes("/") && s.toLowerCase() !== base.toLowerCase()) ((out, name) => { const n = name.trim(); if (!n || n.length > 120 || /[\r\n]/.test(n) || PLACE_EMAIL.test(n)) return; const key = n.toLowerCase(); if (out.some((x) => x.toLowerCase() === key) || out.length >= PLACE_CAP) return; out.push(n); })(out, s);
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

function placeScan(o: Record<string, unknown>, cwds: string[], out: string[], depth: number): void {
  if (depth > 1) return;
  if (typeof o.cwd === "string") {
    const n = o.cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (n.length >= 2 && !cwds.some((x) => x.toLowerCase() === n.toLowerCase())) cwds.push(n);
  }
  for (const k of PLACE_PATH_KEYS) if (k in o) placeAddValue(o[k], cwds, out, 0);
  for (const k of PLACE_GOAL_KEYS) {
    const text = o[k];
    if (typeof text !== "string" || !text || text.length > 200 || /[\r\n]/.test(text)) continue;
    try {
      for (const tok of pathCues(text.replace(PLACE_EMAIL, " "))) {
        if (out.length >= PLACE_CAP) break;
        const parts = tok.split("/").filter(Boolean);
        if (!parts.length || !parts.every((p) => PLACE_SEG.test(p)) || !PLACE_DOTTED.test(parts[parts.length - 1] ?? "")) continue;
        ((out, name) => { const n = name.trim(); if (!n || n.length > 120 || /[\r\n]/.test(n) || PLACE_EMAIL.test(n)) return; const key = n.toLowerCase(); if (out.some((x) => x.toLowerCase() === key) || out.length >= PLACE_CAP) return; out.push(n); })(out, tok);
      }
    } catch {}
  }
  if (depth === 0) {
    for (const nest of ["context", "editor"] as const) {
      const child = o[nest];
      if (child && typeof child === "object" && !Array.isArray(child)) placeScan(child as Record<string, unknown>, cwds, out, depth + 1);
    }
  }
}

export function placePathsFrom(raw: unknown): string[] {
  try {
    const out: string[] = [];
    const cwds: string[] = [];
    try {
      const n = process.cwd().trim().replace(/\\/g, "/").replace(/\/+$/, "");
      if (n.length >= 2) cwds.push(n);
    } catch {}
    if (typeof raw === "string" || Array.isArray(raw)) {
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

const WRAP_PLACE_FIELDS = ["open_files", "openFiles", "files", "file_paths", "filePaths", "file_path", "filePath", "recently_viewed_files", "recentlyViewedFiles"] as const;

const CHAT = /^(ok|okay|thanks|thank you|got it|sure|yeah|yep|hmm|wait|anyway|nah|hey|yo|lol|haha|lmao|nope|np|wow|whoa|idk|dunno|alright|gotcha|sounds good|lgtm|ack|cheers|ty|gg|brb|nvm|omg|kk|yup|thx|ttyl|smh|wfm|idc|ngl|fr|ikr|meh|ugh|welp|yikes|oops|huh)\b/i;
const ACK_PREFIX = /^(?:(?:please\s+remember|remember(?:\s+that)?|got it|understood(?:[,']?\s*I'?ll follow that)?|for reference|fyi|heads up|one rule(?:\s+for\s+this\s+repo)?|going forward)[:,!.]?\s+)+/i;
const SPEAKER_LABEL = /^([A-Z][A-Za-z0-9 /._-]{1,32}:)(?=\s)/;

const FUNC_WORD = new Set([
  "i","we","you","he","she","they","my","our","your","his","her","their","me","us","him","them",
  "is","are","was","were","am","be","been","being","has","have","had","having",
  "do","does","did","will","would","can","could","should","must","might","may",
  "the","a","an","and","but","of","to","in","on","at","for","with","from","by","as","that","this",
  "these","those","it","its","because","if","so","also","when","who","which","not","no",
]);

const SECRET_INLINE = /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9/_-]+/g;

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
    const parts = raw.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8);
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
    if (!((t) => { const numbered = t.split(/\n/).filter((l) => /^\s*(?:\[[a-z][a-z0-9_-]*(?:\s*·[^\]]*)?\]\s+)?\d+[.)]\s+/.test(l)); if (numbered.length >= 2) return true; const sents = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8); if (sents.length < 2) return false; let copula = 0; for (const s of sents) { try { if (objectAsserted(s)) copula++; } catch {} } return copula >= 2 && copula * 2 >= sents.length; })(t)) {
      if (t.length > 400) return "narrative";
      if (t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8).length >= 2 && t.length >= 150) {
        const toks = (s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(t);
        if (toks.length >= 4) {
          let fw = 0;
          for (const w of toks) if (FUNC_WORD.has(w) && ++fw >= 2) return "narrative";
        }
      }
    }
    return "chat";
  } catch {
    return "chat";
  }
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
      const sp = new Set((s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])((t.match(SPEAKER_LABEL)?.[1] || "").replace(/:$/, "")));
      if (!(s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(t).some((w) => !sp.has(w) && (w.length >= 5 || /^\d/.test(w)) && !STOP.has(w))) continue;
    }
    if (t.length >= 8 && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

export function pathCues(lower: string): Set<string> {
  const out = new Set<string>();
  lower = lower.toLowerCase();
  for (const m of lower.matchAll(/(?:^|[\s"'`(,:])((?:[a-z0-9_.-]+\/)+[a-z0-9_.-]*)/g)) {
    const segs = m[1]!.split("/").filter((s) => s.length >= 3);
    for (const s of segs) out.add(s);
    if (segs.length >= 2) out.add(segs.slice(0, 2).join("/"));
  }
  for (const m of lower.matchAll(/(?:^|[\s"'`(,:])([a-z0-9_-]+(?:\.[a-z][a-z0-9]*)+)\b/g)) {
    if (m[1]!.length >= 3) out.add(m[1]!);
  }
  return out;
}

const SAL_STRONG = /\b(root cause|because|instead of|rather than|decided|we chose|chose|settled on|going with|never|always|do not|don'?t|must|the fix (?:was|is)|fixed (?:it )?by|turned out|the reason|that'?s why|that is why|so that)\b/i;
const SAL_WEAK = /\b(?:i|we) (?:changed|added|fixed|raised|moved|switched|replaced|set|bumped|pointed|deleted|removed|rewrote|derived|forced|chunked|serialised|serialized|used|wired|dropped|renamed|reverted|pinned|upgraded|downgraded|disabled|enabled|patched|migrated|recreated)\b|\b(?:should|prefer|convention|rule|instead)\b/i;

const jaccardText = (a: string, b: string): number => { const A = new Set((s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(a)), B = new Set((s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(b)); let i = 0; for (const w of A) if (B.has(w)) i++; const u = A.size + B.size - i; return u ? i / u : 0; };

export const MEMORY_WAL_COMPACT_LINES = 32;

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
        const c = ((rec) => ({ rec, needles: [...new Set([...rec.tags.filter((t) => t.length >= 3 && !STOP.has(t)), ...(s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(rec.text).filter((w) => w.length >= 3 && !STOP.has(w))])] }))(rec);
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
  ingestMemoryJsonl(`${path}.wal`, out, idx, true);
  return out;
}

const STATUS_OBJECT = /\b(?:failing|broken|down|flaky|crashing|hanging|erroring|working|ready|live|dead|ok|fine|slow|errors?|offline|unavailable)\b/i;

export function subjectKey(text: string): string | null {
  const cleaned = text.trim()
    .replace(/^(?:fyi|for reference|heads up|noted|got it|note|ok|okay|update|reminder|understood(?:[,']?\s*I'?ll follow that)?|one rule(?: for this repo)?|going forward)[:,]?\s+/i, "")
    .replace(/^I'?ll follow that:\s*/i, "");
  const ci = cleaned.match(/^ci(?:\s+is(?:\s+now)?|:)\s+(\S.*)$/i);
  if (ci) return STATUS_OBJECT.test(ci[1]!) ? null : "ci";
  const m = cleaned.match(/^(.{4,80}?)\s+(?:is now|are now|is|are|was|were|prefers?|uses\b|using\b|lives in|live in|stays in|stay in|moved to|belongs to|owned by|ship from|ships from)\s+(\S.*)$/i);
  if (!m) return null;
  if (STATUS_OBJECT.test(m[2]!)) return null;
  const k = m[1]!.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return k.length >= 4 ? k : null;
}

export const PACKET_CHAT_K_MIN = 6;
export const PACKET_CHAT_K_MAX = 10;
export const PROCEDURE_TOKEN_CAP = 300;
export const PROCEDURE_CHAR_CAP = PROCEDURE_TOKEN_CAP * 4;

export function memoryRetrieveCap(): number {
  const raw = Number(process.env.EDEN_MEMORY_CAP);
  if (!Number.isFinite(raw) || raw <= 0) return PACKET_CHAT_K_MIN;
  return Math.min(PACKET_CHAT_K_MAX, Math.max(PACKET_CHAT_K_MIN, Math.floor(raw)));
}

function formatNote(r: MemoryRecord): MemoryRecord {
  const isProcedure = r.kind === "procedure";
  const raw = typeof r.text === "string" ? r.text : String(r.text ?? "");
  const stripped = stripPacketLabel(raw).body;
  let body = stripped;
  if (isProcedure) body = ((text) => {
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
  })(body);
  else {
    const skipFactCap = r.lane === "icl" || r.lane === "trajectory" || isIclExemplar(r.text) || isIclExemplar(body) || r.lane === "narrative" || (r.tags ?? []).includes("chunk")
      || ((t) => { const numbered = t.split(/\n/).filter((l) => /^\s*(?:\[[a-z][a-z0-9_-]*(?:\s*·[^\]]*)?\]\s+)?\d+[.)]\s+/.test(l)); if (numbered.length >= 2) return true; const sents = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8); if (sents.length < 2) return false; let copula = 0; for (const s of sents) { try { if (objectAsserted(s)) copula++; } catch {} } return copula >= 2 && copula * 2 >= sents.length; })(r.text) || ((t) => { const numbered = t.split(/\n/).filter((l) => /^\s*(?:\[[a-z][a-z0-9_-]*(?:\s*·[^\]]*)?\]\s+)?\d+[.)]\s+/.test(l)); if (numbered.length >= 2) return true; const sents = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8); if (sents.length < 2) return false; let copula = 0; for (const s of sents) { try { if (objectAsserted(s)) copula++; } catch {} } return copula >= 2 && copula * 2 >= sents.length; })(body);
    const factish = r.kind === "fact" || r.kind === "preference" || /^\s*\[fact(?:\s*·[^\]]*)?\]/i.test(body);
    if (!skipFactCap && factish) body = ((text, re, cap) => { const redacted = redact(String(text ?? "")); const t = typeof redacted === "string" ? redacted : String(text ?? ""); const labeled = t.match(re); return labeled ? (labeled[2]!.length <= cap ? t : `${labeled[1]!}${labeled[2]!.slice(0, cap)}`) : (t.length <= cap ? t : t.slice(0, cap)); })(body, /^(\s*\[fact(?:\s*·[^\]]*)?\]\s*)(.*)$/is, PROCEDURE_CHAR_CAP);
  }
  try {
    const tags = Array.isArray(r.tags) ? r.tags : [];
    const skipGistCap = r.lane === "icl" || r.lane === "trajectory" || isIclExemplar(r.text) || isIclExemplar(body)
      || (r.kind === "episode" && tags.includes("chunk"));
    const gistish = r.kind === "digest" || r.kind === "gist"
      || tags.some((t) => t === "gist" || t === "digest")
      || /^\s*\[gist(?:\s*·[^\]]*)?\]/i.test(body);
    if (!skipGistCap && gistish) body = ((text, re, cap) => { const redacted = redact(String(text ?? "")); const t = typeof redacted === "string" ? redacted : String(text ?? ""); const labeled = t.match(re); return labeled ? (labeled[2]!.length <= cap ? t : `${labeled[1]!}${labeled[2]!.slice(0, cap)}`) : (t.length <= cap ? t : t.slice(0, cap)); })(body, /^(\s*\[gist(?:\s*·[^\]]*)?\]\s*)(.*)$/is, GIST_CHAR_CAP);
  } catch { /* fail-open: leave body */ }
  let labeled = body;
  try { labeled = applyProvenanceLabel(r, body); } catch {
    try {
      const kind = noteKindToken(r, body);
      labeled = kind ? `[${kind}] ${body}` : body;
    } catch { labeled = body; }
  }
  return { ...r, text: labeled };
}

export function formatPacketText(r: MemoryRecord): string {
  try { return formatNote(r).text; } catch { return String(r?.text ?? ""); }
}

const HOWTO_SCHEMA_KEYS = new Set(["command", "cmd", "script", "path", "file", "filepath", "filename"]);
const HOWTO_EXACT = 1_000_000;
const HOWTO_GAP_CMD = /\bpytest\b|\bnpm\b|\brm\s|\bcd\s|\bbash\s|[|;&]/i;

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
  for (const t of (s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(text)) {
    if (dropStops && (t.length < 2 || STOP.has(t))) continue;
    out.add(t);
  }
  for (const p of pathCues(text.toLowerCase())) out.add(p);
}

export function howtoAboutness(cue: string, row: { cue?: string; files?: string[]; verify?: string; steps?: { args?: Record<string, unknown> }[] }): number {
  const q = String(cue ?? "").trim();
  if (!q) return 0;
  const rowCue = typeof row.cue === "string" ? row.cue : "";
  const nq = q.toLowerCase().replace(/\s+/g, " ");
  const nr = rowCue.trim().toLowerCase().replace(/\s+/g, " ");
  if (nq && nq === nr) return HOWTO_EXACT;
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
    const stem = ((v?: string) => { if (!v) return ""; const first = v.trim().toLowerCase().split(/\s+/)[0] ?? ""; const cleaned = first.replace(/^['"]+|['"]+$/g, ""); return (cleaned.split(/[/\\]/).pop() ?? cleaned).trim(); })(row.verify);
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
  const stem = ((v?: string) => { if (!v) return ""; const first = v.trim().toLowerCase().split(/\s+/)[0] ?? ""; const cleaned = first.replace(/^['"]+|['"]+$/g, ""); return (cleaned.split(/[/\\]/).pop() ?? cleaned).trim(); })(typeof row.verify === "string" ? row.verify : undefined);
  const stemHit = !!(stem && (qToks.has(stem) || [...qPlaces].includes(stem)));
  if (placeHit || stemHit) return Math.max(n, 1) + (placeHit ? 10 : 0) + (stemHit ? 5 : 0);
  if (n >= 2) return n;
  return ((a, b) => {
    try {
      const fn = (globalThis as { edenHowtoEmbed?: (x: string, y: string) => number }).edenHowtoEmbed;
      if (typeof fn !== "function") return 0;
      const n = Number(fn(a, b));
      return Number.isFinite(n) && n > 0 ? Math.min(n, 0.999) : 0;
    } catch {
      return 0;
    }
  })(q, [row.cue ?? "", ...(Array.isArray(row.files) ? row.files : []), row.verify ?? "", ...howtoSchemaValues(row.steps ?? [])].join(" "));
}

function howtoProcedureRecord(view: ReturnType<typeof retrieveHowTo>[number]): MemoryRecord {
  const cue = typeof view.cue === "string" ? view.cue.trim() : "";
  const seen = new Set<string>();
  const files: string[] = [];
  const add = (f: unknown) => {
    if (typeof f !== "string") return;
    const s = f.trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    files.push(s);
  };
  if (Array.isArray(view.files)) for (const f of view.files) add(f);
  if (!files.length && Array.isArray(view.steps)) {
    for (const s of view.steps) {
      if (Array.isArray(s?.files)) for (const f of s.files) add(f);
      const args = s?.args;
      if (!args) continue;
      for (const k of ["path", "file", "filepath", "filename"] as const) add(args[k]);
    }
  }
  let verify = typeof view.verify === "string" ? view.verify.trim() : "";
  if (!verify && Array.isArray(view.steps)) {
    for (let i = view.steps.length - 1; i >= 0; i--) {
      const args = view.steps[i]?.args;
      if (!args) continue;
      for (const k of ["command", "cmd", "script"] as const) {
        const v = args[k];
        if (typeof v === "string" && v.trim()) {
          verify = v.trim();
          break;
        }
      }
      if (verify) break;
    }
  }
  let text = cue;
  if (files.length) text = text ? `${text} → ${files.join(" ")}` : files.join(" ");
  if (verify) text = text ? `${text} · verify: ${verify}` : `verify: ${verify}`;
  const gaps = view.gaps;
  let unknown: string | undefined;
  if (Array.isArray(gaps) && gaps.length) {
    const raw = typeof gaps[0]?.reason === "string" ? gaps[0].reason.trim() : "";
    unknown = !raw || HOWTO_GAP_CMD.test(raw) ? "missing step" : raw;
  }
  if (unknown) text = text ? `${text} · unknown: ${unknown}` : `unknown: ${unknown}`;
  return { id: view.id, kind: "procedure", tags: ["howto", "procedure"], text, at: view.t, sal: 0 };
}

function scrubNarrativeLeftovers<T extends { text: string; lane?: string; tags?: string[] }>(
  notes: T[],
  store: SemanticStore,
): T[] {
  try {
    if (!Array.isArray(notes)) return notes;
    const out: T[] = [];
    for (const n of notes) {
      if (!n || typeof n !== "object") continue;
      if (!(n.lane === "narrative" || (n.tags ?? []).includes("chunk")) && n.lane !== "trajectory") {
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

function mergeNarrativeLane(lexical: MemoryRecord[], text: string, cap: number, dir: string, compiled: MemoryRecord[] = []): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q) return lexical;
    if (((text) => { try { if (isBookQaCue(text) && !/\blabel\s*:/i.test(text)) return false; if (encodeLane(text) === "icl") return true; if (isIclExemplar(text) || /\blabel\s*:/i.test(text)) return true; } catch {} return false; })(q)) return lexical;
    const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0)));
    if (!k) return lexical;
    const hits = retrieveNarrativeChunks(dir, q, { k, fallback: compiled });
    const chat = Array.isArray(lexical) ? lexical.filter((l) => !(l.lane === "narrative" || (l.tags ?? []).includes("chunk"))) : [];
    if (!Array.isArray(hits) || !hits.length) return chat;
    const chunks: MemoryRecord[] = [];
    for (const hit of hits) {
      const body = String(hit?.text ?? "").trim();
      if (!body) continue;
      chunks.push(memRec(hit.id || `chunk:${hit.src || "anon"}:${chunks.length}`, body, "episode", "narrative", ["chunk"], Number.isFinite(hit.t) ? hit.t : 0));
    }
    if (!chunks.length) return chat;
    const out: MemoryRecord[] = [];
    for (const c of [...chunks, ...chat]) {
      if (out.length >= cap) break;
      if (out.some((p) => p.id === c.id || jaccardText(p.text, c.text) > 0.6)) continue;
      out.push(c);
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
      out.push(memRec(id, body, "fact", "icl", ["icl"], Number.isFinite(hit.t) ? hit.t : 0));
    }
    return out;
  } catch {
    return [];
  }
}

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

function mergeExperienceLane(lexical: MemoryRecord[], text: string, dir: string): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q) return lexical;
    if (((text) => { try { if (isBookQaCue(text) && !/\blabel\s*:/i.test(text)) return false; if (encodeLane(text) === "icl") return true; if (isIclExemplar(text) || /\blabel\s*:/i.test(text)) return true; } catch {} return false; })(q)) return lexical;
    const hits = retrieveExperience(dir, q);
    if (!Array.isArray(hits) || !hits.length) return lexical;
    const extra: MemoryRecord[] = [];
    for (const hit of hits) {
      const body = String(hit?.text ?? "").trim();
      if (!body) continue;
      extra.push(memRec(`exp:${hit.id}`, body, "episode", "trajectory", ["experience", "trajectory"], Number.isFinite(hit.t) ? hit.t : 0));
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

function mergeGistLane(lexical: MemoryRecord[], text: string, cap: number, dir: string): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q) return lexical;
    if (((text) => { try { if (isBookQaCue(text) && !/\blabel\s*:/i.test(text)) return false; if (encodeLane(text) === "icl") return true; if (isIclExemplar(text) || /\blabel\s*:/i.test(text)) return true; } catch {} return false; })(q)) return lexical;
    const hits = retrieveGists(dir, q, { k: Math.min(3, cap) });
    if (!hits.length) return lexical;
    const gists: MemoryRecord[] = hits.map((h) => memRec(h.id || `gist:${h.level}:${h.t}`, h.text, "gist", "narrative", ["gist"], h.t));
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
  readonly session?: string;
  readonly child: boolean;
  get jsonlDir(): string {
    return dirname(this.path);
  }
  get howtoDir(): string {
    return this.dir;
  }
  private know?: KnowSearch;
  private agent?: string;
  private project?: string;
  private scrubSession?: string;
  private scrubCwd?: string;
  private compiled: Compiled[];
  private path: string;
  private lastWin: string[] = [];
  private batch = 0;
  private dirty = false;
  private durableIds = new Set<string>();
  private walDirtyIds = new Set<string>();
  private deletedIds = new Set<string>();
  private needCompact = false;
  private sem?: SemanticStore;
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
    const pin = opts.pin === true || ((t) => !/\b(?:don'?t|do not|never)\s+remember\b/i.test(t) && (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(t) || /\balways\s+\S/i.test(t)))(uttered);
    let sal = opts.sal ?? ((t) => SAL_STRONG.test(t) ? 1 : SAL_WEAK.test(t) ? 0.6 : 0)(rec.text.replace(SPEAKER_LABEL, ""));
    if (pin) {
      sal = Math.max(sal, opts.pin === true || /\b(?:always|remember)\b/i.test(uttered) ? 1 : 0.6);
      if (!rec.tags.includes("pin")) rec.tags.push("pin");
    }
    if (sal > 0) rec.sal = sal;
    const c = ((rec) => ({ rec, needles: [...new Set([...rec.tags.filter((t) => t.length >= 3 && !STOP.has(t)), ...(s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(rec.text).filter((w) => w.length >= 3 && !STOP.has(w))])] }))(rec), i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    i >= 0 && this.compiled.splice(i, 1);
    this.compiled.push(c);
    this.walDirtyIds.add(rec.id);
    if (!this.project || rec.project === this.project) this.seenLower.add(rec.text.toLowerCase());
    return this.flush(true), rec;
  }

  private rebuildSeen() {
    this.seenLower = new Set();
    for (const c of this.compiled) {
      if (!this.project || c.rec.project === this.project) this.seenLower.add(c.rec.text.toLowerCase());
    }
  }

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
    const batchLive = new Map<string, string>();
    for (let i = start; i < items.length; i++) {
      const it = items[i]!;
      const safe = this.persistText(it.text);
      const lane = encodeLane(it.text);
      if (lane === "icl" || lane === "narrative") {
        let text = safe;
        if (lane === "narrative" && opts.keepLiveIdentity) {
          try { text = omitConflictingIdentity(text, (this.sem ??= new SemanticStore(this.dir))); } catch {}
        }
        if (text && !this.seenLower.has(text.toLowerCase())) {
          const tags = (s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(text).concat([lane]);
          try { if (isRecsysShot(it.text)) tags.push("recsys"); } catch {}
          const rec = this.remember(text, {
            kind: lane === "narrative" ? "episode" : "fact",
            lane,
            tags,
            sal: ((t) => SAL_STRONG.test(t) ? 1 : SAL_WEAK.test(t) ? 0.6 : 0)(text.replace(SPEAKER_LABEL, "")),
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
            const store = (sem ??= (this.sem ??= new SemanticStore(this.dir)));
            const live = store.get(fact.s, fact.p);
            if (opts.keepLiveIdentity) {
              const obj = fact.o.trim().toLowerCase();
              const slot = `${fact.s}\0${fact.p}`;
              const fromBatch = batchLive.get(slot);
              if (!(fromBatch && fromBatch !== obj)) {
                if (store.supersededObject(fact.o)) continue;
              }
            }
            const serial = String(text).trim().match(/^(\d+)[.)]\s+\S/);
            const serialT = serial && Number.isFinite(Number(serial[1])) ? Number(serial[1]) : undefined;
            if (serialT != null || !live || live.t >= 1e11 || batchLive.has(`${fact.s}\0${fact.p}`)) {
              store.put(fact.s, fact.p, fact.o, serialT ?? Date.now());
              batchLive.set(`${fact.s}\0${fact.p}`, fact.o.trim().toLowerCase());
            }
          }
        } catch {}
        if (this.seenLower.has(text.toLowerCase())) continue;
        const key = isToolProse(text) ? null : subjectKey(text);
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
        const pin = ((t) => !/\b(?:don'?t|do not|never)\s+remember\b/i.test(t) && (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(t) || /\balways\s+\S/i.test(t)))(safe) || ((t) => !/\b(?:don'?t|do not|never)\s+remember\b/i.test(t) && (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(t) || /\balways\s+\S/i.test(t)))(it.text);
        out.push(this.remember(text, { kind: pin ? "constraint" : /\b(prefer|never |always |don'?t |do not |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b/i.test(text) ? "episode" : "fact", lane: "chat", tags: (s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(text).concat(extraTags), sal: pin ? Math.max(0.6, ((t) => SAL_STRONG.test(t) ? 1 : SAL_WEAK.test(t) ? 0.6 : 0)(text.replace(SPEAKER_LABEL, ""))) : ((t) => SAL_STRONG.test(t) ? 1 : SAL_WEAK.test(t) ? 0.6 : 0)(text.replace(SPEAKER_LABEL, "")), pin }));
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
    const cap = Number(process.env.EDEN_MEMORY_STORE_CAP) || 2000;
    const wal = `${this.path}.wal`;
    try {
      withFileLock(`${this.path}.lock`, () => {
        let pending = this.compiled.filter((c) => this.walDirtyIds.has(c.rec.id));
        let walN = 0;
        try {
          if (existsSync(wal)) {
            for (const t of readFileSync(wal, "utf8").split("\n")) if (t) walN++;
          }
        } catch {}
        let snapshotMissing = false;
        try { snapshotMissing = !existsSync(this.path); } catch { snapshotMissing = true; }
        let compact = this.needCompact || snapshotMissing || this.compiled.length > cap || walN + pending.length >= MEMORY_WAL_COMPACT_LINES;
        if (compact) {
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
    }
  }

  relevant(text: string, cap = memoryRetrieveCap()): MemoryRecord[] {
    let route: MemoryRoute = "chat-jsonl";
    try { route = routeMemory(text); } catch { route = "chat-jsonl"; }
    try {
      const live = this.compiled.filter((c) => c.rec.kind !== "digest");
      if (live.length >= 4 && live.every((c) => c.rec.lane === "icl" || isIclExemplar(String(c.rec.text ?? "")))) route = "icl-index";
    } catch {}
    memoryLastRoute.route = route;
    const recs = this.compiled.map((c) => c.rec);
    if (route === "icl-index") {
      const packed = mergeIclLane([], text, cap, this.howtoDir, recs);
      return packed.length < 2 ? packed : dedupSelect(packed.map((rec) => ({ rec, n: 0 })), packed.length);
    }
    if (route === "gist-chunk") {
      const packed = mergeGistLane(mergeNarrativeLane([], text, cap, this.howtoDir, recs), text, cap, this.howtoDir);
      return packed.length < 2 ? packed : dedupSelect(packed.map((rec) => ({ rec, n: 0 })), packed.length);
    }
    const hay = queryHay(text);
    try {
      const expand: Record<string, string[]> = {
        login: ["auth", "oauth", "signin"],
        signin: ["auth", "login", "oauth"],
        checkout: ["payment", "payments", "billing"],
        payment: ["checkout", "billing"],
        install: ["package", "lockfile"],
        lockfile: ["package", "install"],
        prod: ["deploy", "deployment"],
        deploy: ["prod"],
        upload: ["object", "store"],
        avatar: ["object", "store"],
        experiment: ["flag", "flags"],
        assigning: ["flag", "flags"],
        connection: ["database"],
        dashboard: ["database"],
        welcome: ["email"],
        mail: ["email"],
        sha: ["git", "bash"],
        git: ["bash"],
        session: ["cache"],
        hanging: ["package"],
      };
      for (const t of [...hay]) {
        const extra = expand[t];
        if (!extra) continue;
        for (const x of extra) hay.add(x);
      }
    } catch {}
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
    try {
      if (String(text ?? "").trim()) {
        lexical = ((extras, lexical, cap) => { const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0))); if (!k || !extras.length) return lexical; extras.sort((a, b) => b.at - a.at); const base = Array.isArray(lexical) ? lexical : []; const out: MemoryRecord[] = []; const room = Math.max(k, 64); for (const r of extras) { if (out.length >= room) break; if (out.some((p) => p.id === r.id) || base.some((p) => p.id === r.id)) continue; out.push(r); } for (const l of base) { if (out.length >= room) break; if (out.some((p) => p.id === l.id)) continue; out.push(l); } return out.length ? out : base; })(rows.filter((c) => c.rec.kind === "constraint").map((c) => c.rec), lexical, cap);
      }
    } catch {}
    try {
      if (String(text ?? "").trim()) {
        const live = new SemanticStore(this.dir).live();
        if (Array.isArray(live) && live.length) {
          const extras: MemoryRecord[] = [];
          for (const row of live) {
            let subj = String(row.s ?? "").trim();
            let obj = String(row.o ?? "").trim();
            const pred = String(row.p ?? "").trim().toLowerCase();
            if (!subj || !obj || !pred) continue;
            try {
              subj = scrubMemoryText(subj);
              obj = scrubMemoryText(obj);
            } catch {}
            if (!subj || !obj || subj === "[cwd]" || obj === "[cwd]" || subj === "[session]" || obj === "[session]" || subj === "[email]" || obj === "[email]") continue;
            const titled = subj.charAt(0).toUpperCase() + subj.slice(1);
            const body = pred === "uses" ? `${subj} uses ${obj}` : pred === "is" ? (/^[A-Z]/.test(obj) ? `${titled} is ${obj}.` : `The ${subj} is ${obj}.`) : `${titled} ${pred} ${obj}`.replace(/\s+/g, " ").trim();
            extras.push({
              id: `sem:${row.s}:${row.p}`,
              text: body,
              kind: "fact",
              lane: "chat",
              tags: ["fact", "semantic", "x-identity"],
              at: Number.isFinite(row.t) ? row.t : 0,
            });
          }
          lexical = ((extras, lexical, cap) => { const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0))); if (!k || !extras.length) return lexical; extras.sort((a, b) => b.at - a.at); const base = Array.isArray(lexical) ? lexical : []; const out: MemoryRecord[] = []; const room = Math.max(k, 64); for (const r of extras) { if (out.length >= room) break; if (out.some((p) => p.id === r.id) || base.some((p) => p.id === r.id)) continue; out.push(r); } for (const l of base) { if (out.length >= room) break; if (out.some((p) => p.id === l.id)) continue; out.push(l); } return out.length ? out : base; })(extras, lexical, cap);
        }
      }
    } catch {}
    try {
      const stop = new Set(["the", "is", "a", "an", "of", "and", "or", "to", "in", "on", "for", "our", "we", "it", "do", "does", "did", "are", "was", "be", "use", "uses", "what", "where", "why", "how", "who"]);
      lexical = lexical.filter((r) => {
        const toks = [...queryHay(r.text ?? "")].filter((t) => t.length >= 3 && !stop.has(t));
        for (const t of toks) {
          if (hay.has(t)) return true;
          for (const h of hay) {
            if (h.length < 4 || stop.has(h)) continue;
            if (t.startsWith(h) || h.startsWith(t)) return true;
          }
        }
        return false;
      });
    } catch {}
    const packed = mergeExperienceLane(
      mergeHowtoLane(mergeNarrativeLane(lexical, text, cap, this.howtoDir, recs), text, cap, this.howtoDir),
      text,
      this.howtoDir,
    );
    return packed.length < 2 ? packed : dedupSelect(packed.map((rec) => ({ rec, n: 0 })), packed.length);
  }

  notesFor(text = "", k = memoryRetrieveCap()): MemoryRecord[] {
    if (text) {
      const pool = Math.min(18, Math.max(Math.floor(Number(k) || 0), 12));
      const recs = this.relevant(text, pool);
      const mixed = ((list, cap) => {
        try {
          const rows = Array.isArray(list) ? list : [];
          const out: MemoryRecord[] = [];
          let chars = 0;
          const floor = Math.max(1, Math.floor(Number(cap) || 6));
          for (const r of rows) {
            const n = String(r.text ?? "").length;
            if (out.length >= floor && chars + n > MEMORY_X_FAT_CHARS) continue;
            out.push(r);
            chars += n;
            if (chars >= MEMORY_X_FAT_CHARS && out.length >= floor) break;
          }
          return (out.length ? out : rows.slice(0, floor)).map(formatNote);
        } catch {
          return (Array.isArray(list) ? list : []).map(formatNote);
        }
      })(recs, k);
      try { return dropHarmed(this.dir, mixed); } catch { return mixed; }
    }
    const recs = this.memories().filter((r) => !(r.lane === "narrative" || (r.tags ?? []).includes("chunk")) && r.lane !== "icl" && r.lane !== "trajectory");
    const emptyCue = ((rows) => [...rows.filter((r) => r.kind === "constraint").slice(-k), ...rows.filter((r) => r.kind !== "constraint").slice(-k)].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i).slice(0, k))(recs).map(formatNote);
    try { return dropHarmed(this.dir, emptyCue); } catch { return emptyCue; }
  }

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
          const fromMsg = placePathsFrom(Array.isArray(list) ? list.findLast((x) => { if (!x || typeof x !== "object") return false; const role = String((x as { role?: unknown }).role ?? "").toLowerCase(); if (role === "system") return false; const text = convBlob([x]).trim(); return !!text && !text.startsWith(MEMORY_MARK) && (role === "user" || role === "human"); }) : undefined);
          const extra: string[] = [];
          if (extraPaths) for (const p of extraPaths) if (typeof p === "string") extra.push(p);
          rankCue = cue ? attachPlaceCues(cue, extra.length ? [...fromMsg, ...extra] : fromMsg) : "";
        } catch {
          rankCue = cue;
        }
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
          let skipHop = false;
          try {
            if (memoryLastRoute.route === "icl-index" || memoryLastRoute.route === "gist-chunk") skipHop = true;
            else if (((text) => { try { if (isBookQaCue(text) && !/\blabel\s*:/i.test(text)) return false; if (encodeLane(text) === "icl") return true; if (isIclExemplar(text) || /\blabel\s*:/i.test(text)) return true; } catch {} return false; })(rankCue)) skipHop = true;
            else if (isRecsysShot(rankCue)) skipHop = true;
            else if (isSummaryCue(rankCue)) skipHop = true;
            else if (isBookQaCue(rankCue)) skipHop = true;
            else if (retrieved.every((m) => m.lane === "icl" || isIclExemplar(m.text))) skipHop = true;
          } catch {}
          if (!silent && rankCue && retrieved.length && !skipHop) {
            const hopStore = (() => {
              const out: MemoryRecord[] = [];
              const seen = new Set<string>();
              const push = (m: MemoryRecord | { id?: string; text?: string; lane?: string; kind?: string; at?: number; tags?: string[] }) => {
                try {
                  const text = String(m?.text ?? "").trim();
                  if (!text) return;
                  if ((m as { lane?: string }).lane === "icl" || isIclExemplar(text)) return;
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
                  push(memRec(c.id, c.text, "episode", "narrative", ["chunk"], c.t));
                }
              } catch {}
              try {
                for (const m of this.memories()) {
                  if (m.lane === "narrative" && !(m.tags ?? []).includes("chunk")) continue;
                  push(m);
                }
              } catch {}
              return out;
            })();
            let hopPool = hopStore;
            try { hopPool = dropHarmed(this.dir, hopStore); } catch { hopPool = hopStore; }
            hopped = completeNotes(rankCue, retrieved, hopPool);
            packet = hopped.length ? assembleNotes(hopped, this.dir) : [];
            packet = completeNotes(rankCue, packet, hopPool, { pull: false });
          } else {
            packet = hopped.length ? assembleNotes(hopped, this.dir) : [];
          }
        } catch {
          packet = !silent && retrieved.length ? assembleNotes(retrieved, this.dir) : [];
        }
        try { if (rankCue && !silent) packet = scrubNarrativeLeftovers(packet, (this.sem ??= new SemanticStore(this.dir))); } catch {}
        packet = packet.map(formatNote);
        try { packet = dropHarmed(this.dir, packet); } catch {}
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
      if (process.env.EDEN_MEMORY_SWALLOW === "1") console.error("eden-memory inject swallow", memoryInjectSwallows.n);
      return list;
    }
  }

  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    try { if (memoryConsent() === "off") return body; } catch { return body; }
    const key = Array.isArray(body.messages) ? "messages" : Array.isArray(body.contents) ? "contents" : "messages", m = Array.isArray(body[key]) ? (body[key] as unknown[]) : [], sys = body.systemInstruction ?? body.system_instruction ?? body.system ?? body.system_prompt ?? body.systemPrompt;
    try {
      const sysBlob = typeof sys === "string" ? sys : sys ? convBlob(Array.isArray(sys) ? sys : [sys]) : "";
      let extra: string[] = [];
      try { extra = placePathsFrom(body); } catch { extra = []; }
      const next = alreadyInjected(sysBlob) || sysBlob.includes(MEMORY_MARK) ? (this.observe(m), m) : this.inject(m, extra);
      if (sys) this.observe(typeof sys === "string" ? [{ role: "user", content: sys }] : [sys], { keepLiveIdentity: true });
      if (next === m) return body;
      const merged: Record<string, unknown> = { ...body, [key]: next };
      for (const k of WRAP_PLACE_FIELDS) delete merged[k];
      return merged;
    } catch {
      memoryInjectSwallows.n++;
      if (process.env.EDEN_MEMORY_SWALLOW === "1") console.error("eden-memory inject swallow", memoryInjectSwallows.n);
      return body;
    }
  }
  quiet(fn: () => void) {
    this.batch++;
    const sem = (this.sem ??= new SemanticStore(this.dir));
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
      return ((rec) => ({ rec, needles: [...new Set([...rec.tags.filter((t) => t.length >= 3 && !STOP.has(t)), ...(s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(rec.text).filter((w) => w.length >= 3 && !STOP.has(w))])] }))({ ...c.rec, text: next });
    });
    if (dirty) this.flush(true);
  }

  async sleep(opts?: { session?: string }): Promise<void> {
    try { if (memoryConsent() !== "on") return; } catch { return; }
    try { consolidate(this, opts); } catch {}
  }

  close() {
    try { clearSleepTimer(this); } catch {}
    try { if (existsSync(`${this.path}.wal`)) this.needCompact = true; } catch {}
    if (this.needCompact) this.dirty = true;
    this.flush(false);
  }
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

let proc: AgentMemory | undefined;

export function processMemory(): AgentMemory {
  if (process.argv.some((a) => a.endsWith(".test.ts"))) {
    return openMemory({ dir: join(tmpdir(), "eden-m-" + Math.random().toString(36).slice(2)) });
  }
  const dir = process.env.EDEN_MEMORY_DIR || (process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : undefined);
  const root = dir || join(homedir(), ".eden", "memory");
  let session: string | undefined;
  let child = false;
  const parent = memorySessionName(process.env.EDEN_MEMORY_SESSION) ?? memorySessionName(process.env.EDEN_MEMORY_PARENT);
  const childId = memorySessionName(process.env.EDEN_MEMORY_CHILD);
  if (childId) {
    session = childSessionName(parent, childId);
    child = true;
  } else {
    session = parent;
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

export { sleep, consolidate } from "./sleep";

