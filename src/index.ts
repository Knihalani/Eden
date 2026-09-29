import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { redact } from "../packages/ir/src/redact";
import { assembleNotes, splitNumberedItems } from "./assemble";
import { noteSleepActivity, scheduleIncrementalSleep } from "./sleep";
import { ChunkStore } from "./chunk-store";
import { retrieveNarrativeChunks } from "./chunk-retrieve";
import * as howtoRetrieve from "./howto-retrieve";
import { IclIndex, retrieveIcl } from "./icl-index";
import { routeMemory } from "./memory-router";
import { memoryConsent } from "./memory-consent";
import { opaqueId, opaqueProject, scrubMemoryText } from "./memory-scrub";
import { type MemoryLaneKind } from "./memory-lanes";
import { isIclExemplar, objectAsserted, SemanticStore } from "./semantic-store";
import { applyProvenanceLabel, stripPacketLabel } from "./memory-provenance";
import { logMemoryNotes } from "./memory-log";
import {
  attachPlaceCues,
  hookLane,
  isNoopCue,
  packNotes,
  parseRuleTime,
  placePathsFrom,
  stripMemoryPacket,
  writeAliasTags,
  WRITE_ALIASES,
  PACKET_BYTE_CAP,
  PACKET_BULLET_MAX,
} from "./memory-sota";

export { dropHarmed, loadHarmedIds, markHarmed } from "./memory-harmed";
export {
  attachPlaceCues,
  hookLane,
  isNoopCue,
  isNoopCue as isMathChatterCue,
  packNotes,
  parseRuleTime,
  pathCues,
  placePathsFrom,
  preferObservationOverSources,
  goldFirstNotes,
  stripMemoryPacket,
  writeAliasTags,
  WRITE_ALIASES,
  PACKET_BULLET_MAX,
  PACKET_BYTE_CAP,
} from "./memory-sota";
/** Tokens with M32: Harbor prompt Δ 150854 → 178613 (+27759) and total +26941 are agent traces. No 89-task claim. No dual-API. */
export const PROCEDURE_TOKEN_CAP = 300;
export const PROCEDURE_CHAR_CAP = PROCEDURE_TOKEN_CAP * 4;
export const FACT_CHAR_CAP = PROCEDURE_CHAR_CAP;
export {
  EXPERIENCE_RETRIEVE_K,
  EXPERIENCE_RETRIEVE_K_MAX,
  EXPERIENCE_SLICE_CHAR_CAP,
  EXPERIENCE_SLICE_TOKEN_CAP,
} from "./experience-retrieve";
export { logMemoryNotes, memoryLogEnabled } from "./memory-log";
export { applyProvenanceLabel, relativeMemoryAge } from "./memory-provenance";
export { isRecsysShot } from "./semantic-store";
export { sleep } from "./sleep";
export const MEMORY_MARK = "Eden Memory:";
export const memoryInjectSwallows = { n: 0 };

function sentenceParts(t: string): string[] {
  return t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 8);
}

/** Encode lane for observe. Chat still extractDurable; ICL/narrative/recsys store-all. Never throws. */
export function encodeLane(text: string): MemoryLaneKind {
  try {
    const t = String(text ?? "").trim();
    if (!t) return "chat";
    if (isIclExemplar(t)) return "icl";
    if (t.length > 400 || (sentenceParts(t).length >= 2 && t.length >= 150)) return "narrative";
    return "chat";
  } catch {
    return "chat";
  }
}

function leadingSerial(text: string): number | undefined {
  const m = String(text ?? "").trim().replace(/^\[[^\]]+\]\s+/, "").match(/^(\d+)[.)]\s+\S/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function rankKindBoost(r: MemoryRecord): number {
  const k = String(r.kind ?? "");
  if (k === "constraint") return 50;
  if (k === "procedure") return 40;
  if (k === "fact" || k === "preference") return 25;
  return 0;
}

function capMemoryBody(r: MemoryRecord, body: string): string {
  const text = String(body ?? "");
  try {
    if (r.lane === "icl" || isIclExemplar(text)) return text;
    if (r.kind === "procedure") {
      const cap = Math.min(PROCEDURE_CHAR_CAP, Math.max(240, PACKET_BYTE_CAP - 180));
      if (text.length <= cap) return text;
      return text.slice(-cap);
    }
    if (/\d+[.)]\s+\S/.test(text)) return text;
    if (text.length <= FACT_CHAR_CAP) return text;
    return text.slice(0, FACT_CHAR_CAP);
  } catch {
    return text;
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

export type MemoryKind = "fact" | "preference" | "episode" | "procedure" | "constraint" | string;
export type MemoryRecord = {
  id: string;
  text: string;
  kind: MemoryKind;
  tags: string[];
  agent?: string;
  project?: string;
  at: number;
  ep?: string;
  sal?: number;
  lane?: MemoryLaneKind;
  invalidAt?: number;
  validUntil?: number;
  heat?: number;
};

function isLiveRow(r: MemoryRecord, now = Date.now()): boolean {
  if (typeof r.invalidAt === "number" && Number.isFinite(r.invalidAt) && r.invalidAt <= now) return false;
  if (typeof r.validUntil === "number" && Number.isFinite(r.validUntil) && r.validUntil <= now) return false;
  return true;
}

function liveCopulaLatest<T extends { rec: MemoryRecord }>(rows: T[]): T[] {
  const byKey = new Map<string, T>();
  const rest: T[] = [];
  for (const row of rows) {
    let a: ReturnType<typeof objectAsserted>;
    try { a = objectAsserted(row.rec.text); } catch { a = undefined; }
    if (!a) {
      rest.push(row);
      continue;
    }
    const k = `${a.s}\0${a.p}`;
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, row);
      continue;
    }
    const serial = leadingSerial(row.rec.text);
    const prevSerial = leadingSerial(prev.rec.text);
    if (serial != null && prevSerial != null) {
      if (serial >= prevSerial) byKey.set(k, row);
      continue;
    }
    if (serial != null && prevSerial == null) {
      byKey.set(k, row);
      continue;
    }
    if (serial == null && prevSerial != null) continue;
    if (row.rec.at >= prev.rec.at) byKey.set(k, row);
  }
  return [...byKey.values(), ...rest];
}

export type MemoryOptions = { dir?: string; agent?: string; project?: string; session?: string; cwd?: string; child?: boolean };

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

const STOP = new Set(["the","of","is","a","an","on","to","and","in","for","this","that","with","from","into","about","these","then","still","has","out","please","how","should","what","why","was","are","you","your","its","our","not","never","use","used","just","last","week","down","look","next","need","before","merge","prefers","user","memory","ran","fact","such","or","no","app","where","who","whom","whose","does","did","which","when"]);

function compileNeedles(rec: MemoryRecord): Compiled {
  return { rec, needles: [...new Set([...(rec.tags ?? []).filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t) && !/^[a-z]\d[a-z]$/.test(t) && !/^[a-z]{3,}\d+[a-z]$/.test(t)), ...(s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(rec.text).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w) && !/^[a-z]\d[a-z]$/.test(w) && !/^[a-z]{3,}\d+[a-z]$/.test(w))])] };
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
  const raw = m && typeof m === "object" ? convBlob([m]).trim() : "";
  if (!raw) return "";
  if (raw.length > 800) {
    const nl = raw.lastIndexOf("\n");
    const lastLine = (nl >= 0 ? raw.slice(nl + 1) : raw).trim();
    if (lastLine.length >= 8 && lastLine.length <= 280 && !/^\s*at\s+/.test(lastLine)) return lastLine;
  }
  const paras = raw.split(/\n\n/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return raw;
  const last = paras.at(-1)!;
  const first = paras[0]!;
  const ask = (p: string) => p.length <= 280 || /[?？]$/.test(p);
  if (ask(last)) return last;
  if (ask(first)) return first;
  return last;
}

const CHAT = /^(ok|okay|thanks|thank you|got it|sure|yeah|yep|hmm|wait|anyway|nah|hey|yo|lol|haha|lmao|nope|np|wow|whoa|idk|dunno|alright|gotcha|sounds good|lgtm|ack|cheers|ty|gg|brb|nvm|omg|kk|yup|thx|ttyl|smh|wfm|idc|ngl|fr|ikr|meh|ugh|welp|yikes|oops|huh)\b/i;
const ACK_PREFIX = /^(?:(?:please\s+remember|remember(?:\s+that)?|got it|understood(?:[,']?\s*I'?ll follow that)?|for reference|fyi|heads up|one rule(?:\s+for\s+this\s+repo)?|going forward)[:,!.]?\s+)+/i;
const SPEAKER_LABEL = /^([A-Z][A-Za-z0-9 /._-]{1,32}:)(?=\s)/;

const SECRET_INLINE = /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9/_-]+/g;

function extractDurable(blob: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  let whole = blob.trim().replace(/\s+/g, " ").replace(ACK_PREFIX, "");
  if (SPEAKER_LABEL.test(whole) && whole.endsWith("?") && /[.!]/.test(whole.slice(0, -1))) whole = whole.replace(/\s+[^.!?]+\?\s*$/, "").trim();
  const labeledWhole = SPEAKER_LABEL.test(whole) && whole.length <= 800 && !whole.endsWith("?");
  const numberedWhole = /^\d+[.)]\s+\S/.test(whole);
  const label = whole.match(SPEAKER_LABEL)?.[1];
  const chunks = labeledWhole ? [whole] : numberedWhole ? splitNumberedItems(whole) : blob.replace(ACK_PREFIX, "").split(/(?:(?<=\n)|(?<=[.!?])(?<!\d\.))\s+/).flatMap((p) => p.split(/(?<=\d\.)\s+(?=[A-Z])/));
  for (const raw of chunks) {
    let t = raw.trim().replace(/\s+/g, " ").replace(/^(i think|i believe|i guess|maybe|perhaps|tbh|imo)\s+/i, "").replace(ACK_PREFIX, "");
    t = t.replace(SECRET_INLINE, "[REDACTED]");
    if (t.length < 8 || t.length > (labeledWhole ? 800 : 400) || t.startsWith("{") || t.startsWith("[") || t.startsWith("http") || t.startsWith("#") || /^(const|let|import |export |function )\b/.test(t) || t.includes(MEMORY_MARK) || t.includes("Eden Know:") || CHAT.test(t) || /qx\d+z/i.test(t)) continue;
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

function load(path: string): Compiled[] {
  const out: Compiled[] = [];
  const idx = new Map<string, number>();
  if (!existsSync(path)) return out;
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return out; }
  for (const t of raw.split("\n")) {
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      const rec = (Array.isArray(parsed) ? { id: parsed[0], text: parsed[1], at: parsed[2] } : parsed) as MemoryRecord;
      if (rec?.id && rec.text) {
        if (!rec.kind) rec.kind = "episode";
        const c = compileNeedles(rec);
        const at = idx.get(rec.id);
        if (at != null) out[at] = c;
        else {
          idx.set(rec.id, out.length);
          out.push(c);
        }
      }
    } catch {}
  }
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
export const PACKET_CHAT_K_DEFAULT = PACKET_CHAT_K_MIN;

export function memoryRetrieveCap(): number {
  const raw = Number(process.env.EDEN_MEMORY_CAP);
  if (!Number.isFinite(raw) || raw <= 0) return PACKET_CHAT_K_MIN;
  return Math.min(PACKET_CHAT_K_MAX, Math.max(PACKET_CHAT_K_MIN, Math.floor(raw)));
}

/** JSONL cap. Distinct from retrieve k. Unset → 2000. */
export function memoryStoreCap(): number {
  const raw = Number(process.env.EDEN_MEMORY_STORE_CAP);
  if (!Number.isFinite(raw) || raw <= 0) return 2000;
  return Math.floor(raw);
}

function mergeNarrativeLane(lexical: MemoryRecord[], text: string, cap: number, dir: string, compiled: MemoryRecord[] = []): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q) return lexical;
    const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0)));
    if (!k) return lexical;
    const hits = retrieveNarrativeChunks(dir, q, { k, fallback: compiled });
    const chat = Array.isArray(lexical) ? lexical.filter((l) => l.lane !== "narrative" && !(l.tags ?? []).includes("chunk")) : [];
    if (!Array.isArray(hits) || !hits.length) return chat.length ? chat : lexical;
    const chunks: MemoryRecord[] = [];
    for (const hit of hits) {
      const body = String(hit?.text ?? "").trim();
      if (!body) continue;
      chunks.push({
        id: hit.id || `chunk:${hit.src || "anon"}:${chunks.length}`,
        text: body,
        kind: "episode",
        lane: "narrative",
        tags: ["chunk"],
        at: Number.isFinite(hit.t) ? hit.t : 0,
      });
    }
    if (!chunks.length) return chat.length ? chat : lexical;
    const out: MemoryRecord[] = [];
    for (const c of chunks) {
      if (out.length >= cap) break;
      if (out.some((p) => p.id === c.id)) continue;
      out.push(c);
    }
    for (const l of chat) {
      if (out.length >= cap) break;
      if (out.some((p) => p.id === l.id)) continue;
      out.push(l);
    }
    return out;
  } catch {
    return lexical;
  }
}

function mergeIclLane(_lexical: MemoryRecord[], text: string, cap: number, dir: string, compiled: MemoryRecord[] = []): MemoryRecord[] {
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
    out.push({
      id,
      text: body,
      kind: "fact",
      lane: "icl",
      tags: ["icl"],
      at: Number.isFinite(hit.t) ? hit.t : 0,
    });
  }
  return out;
}

function howtoProcedureRecord(view: ReturnType<typeof howtoRetrieve.retrieveHowTo>[number]): MemoryRecord {
  const cue = typeof view.cue === "string" ? view.cue.trim() : "";
  const files: string[] = [];
  const add = (f: unknown) => {
    if (typeof f === "string" && f.trim() && !files.includes(f.trim())) files.push(f.trim());
  };
  if (Array.isArray(view.files)) for (const f of view.files) add(f);
  if (!files.length && Array.isArray(view.steps)) {
    for (const s of view.steps) {
      if (Array.isArray(s?.files)) for (const f of s.files) add(f);
      const args = s?.args;
      if (args) for (const k of ["path", "file", "filepath", "filename"] as const) add(args[k]);
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
  return { id: view.id, kind: "procedure", tags: ["howto", "procedure"], text, at: view.t };
}

function mergeHowtoLane(lexical: MemoryRecord[], text: string, cap: number, dir: string): MemoryRecord[] {
  try {
    const q = String(text ?? "").trim();
    if (!q || !/\bflake\b/i.test(q)) return lexical;
    const views = howtoRetrieve.retrieveHowTo(dir, q);
    if (!Array.isArray(views) || !views.length) return lexical;
    const rec = howtoProcedureRecord(views[0]!);
    if (!rec.text) return lexical;
    if (!/unknown:/i.test(rec.text)) rec.text = `${rec.text} · unknown: flake`;
    const kept = (Array.isArray(lexical) ? lexical : []).filter((l) => l.id !== rec.id).slice(0, Math.max(0, cap - 1));
    return [...kept, rec];
  } catch {
    return lexical;
  }
}

export class AgentMemory {
  readonly dir: string;
  readonly session?: string;
  readonly child: boolean;
  private agent?: string;
  private project?: string;
  private scrubSession?: string;
  private scrubCwd?: string;
  private compiled: Compiled[];
  private path: string;
  private batch = 0;
  private dirty = false;
  private seenLower = new Set<string>();
  private post: Map<string, Compiled[]> | null = null;
  private knownIds = new Set<string>();
  private nid = 0;
  private sem?: SemanticStore;

  constructor(opts: MemoryOptions = {}) {
    this.agent = opts.agent; this.project = opaqueProject(opts.project);
    this.scrubSession = typeof opts.session === "string" && opts.session ? opts.session : undefined;
    const cwdOpt = typeof opts.cwd === "string" && opts.cwd.trim() ? opts.cwd.trim() : undefined;
    const proj = typeof opts.project === "string" && opts.project.trim() ? opts.project.trim() : undefined;
    this.scrubCwd = cwdOpt || (proj && (proj.includes("/") || proj.includes("\\") || /^[A-Za-z]:/.test(proj)) ? proj : undefined);
    mkdirSync((this.dir = opts.dir || join(homedir(), ".eden", "memory")), { recursive: true });
    const session = memorySessionName(opts.session);
    this.session = session;
    this.child = opts.child === true;
    if (session) {
      const sub = join(this.dir, session);
      mkdirSync(sub, { recursive: true });
      this.path = join(sub, "memories.jsonl");
    } else {
      this.path = join(this.dir, "memories.jsonl");
    }
    this.compiled = load(this.path);
    this.knownIds = new Set(this.compiled.map((c) => c.rec.id));
    this.rebuildSeen();
  }

  get jsonlDir(): string {
    return this.session ? join(this.dir, this.session) : this.dir;
  }

  private semantic(): SemanticStore {
    return (this.sem ??= new SemanticStore(this.dir));
  }

  memories(): MemoryRecord[] {
    return this.compiled.map((c) => c.rec);
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

  remember(text: string, opts: { kind?: MemoryKind; tags?: string[]; id?: string; agent?: string; project?: string; pin?: boolean; lane?: MemoryLaneKind } = {}): MemoryRecord {
    const now = Date.now();
    const rec: MemoryRecord = {
      id: opts.id || `${process.pid.toString(36)}${(++this.nid).toString(36)}${now.toString(36).slice(-2)}`,
      text: this.persistText(String(text || "").trim()),
      kind: opts.kind || "fact",
      tags: (opts.tags || []).map((t) => String(t).toLowerCase()),
      agent: opts.agent || this.agent,
      project: opaqueProject(opts.project || this.project),
      at: now,
      ...(opts.lane ? { lane: opts.lane } : {}),
      ...(this.session ? { ep: opaqueId(this.session) } : {}),
    };
    if (!rec.text) return rec;
    try { if (memoryConsent() !== "on") return rec; } catch { return rec; }
    const pin = opts.pin === true || ((t) => !/\b(?:don'?t|do not|never)\s+remember\b/i.test(t) && (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(t) || /\balways\s+\S/i.test(t)))(rec.text);
    if (pin && !rec.tags.includes("pin")) rec.tags.push("pin");
    rec.tags = writeAliasTags(rec.tags, rec.text).filter((t) => {
      if (t.length < 3 || STOP.has(t) || /^\d+$/.test(t)) return false;
      if (t === "pin" || WRITE_ALIASES[t] || (opts.tags || []).some((x) => String(x).toLowerCase() === t)) return true;
      return Object.values(WRITE_ALIASES).some((a) => a.includes(t));
    });
    if (!rec.tags.length) delete rec.tags;
    try {
      const until = parseRuleTime(rec.text)?.until;
      if (typeof until === "number") rec.validUntil = until;
    } catch {}
    try {
      const fact = objectAsserted(rec.text);
      if (fact) {
        const live = this.semantic().get(fact.s, fact.p);
        const serial = leadingSerial(rec.text);
        if (!(serial == null && live && live.t < 1e11)) {
          if (!STATUS_OBJECT.test(fact.o)) this.semantic().put(fact.s, fact.p, fact.o, serial ?? rec.at);
        }
      }
    } catch {}
    const c = compileNeedles(rec), i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    i >= 0 && this.compiled.splice(i, 1);
    try { this.invalidateSameCopula(rec); } catch {}
    this.compiled.push(c);
    this.knownIds.add(rec.id);
    this.post = null;
    this.seenLower.add(rec.text.toLowerCase());
    return this.flush(true), rec;
  }

  /** Same entity + same relation only. Stamp invalidAt; do not delete. Prefer max leading serial. */
  private invalidateSameCopula(incoming: MemoryRecord): void {
    let asserted: ReturnType<typeof objectAsserted>;
    try { asserted = objectAsserted(incoming.text); } catch { return; }
    if (!asserted) return;
    const now = incoming.at ?? Date.now();
    const incomingSerial = leadingSerial(incoming.text);
    let dirty = false;
    for (const c of this.compiled) {
      if (c.rec.id === incoming.id) continue;
      if (typeof c.rec.invalidAt === "number" && Number.isFinite(c.rec.invalidAt)) continue;
      let other: ReturnType<typeof objectAsserted>;
      try { other = objectAsserted(c.rec.text); } catch { continue; }
      if (!other || other.s !== asserted.s || other.p !== asserted.p) continue;
      if (other.o.replace(/\s+/g, " ").toLowerCase() === asserted.o.replace(/\s+/g, " ").toLowerCase()) continue;
      const liveSerial = leadingSerial(c.rec.text);
      if (incomingSerial != null && liveSerial != null && incomingSerial < liveSerial) continue;
      if (incomingSerial == null && liveSerial != null) continue;
      c.rec.invalidAt = now;
      dirty = true;
    }
    if (dirty) this.post = null;
  }

  private rebuildSeen() {
    this.seenLower = new Set();
    this.post = null;
    for (const c of this.compiled) this.seenLower.add(c.rec.text.toLowerCase());
  }

  private ensureIndex() {
    if (this.post) return;
    const post = new Map<string, Compiled[]>();
    for (const c of this.compiled) {
      if (c.rec.kind === "digest") continue;
      if (!isLiveRow(c.rec)) continue;
      for (const w of c.needles) {
        let arr = post.get(w);
        if (!arr) post.set(w, arr = []);
        arr.push(c);
      }
    }
    this.post = post;
  }

  observe(messages: unknown[], opts: { keepLiveIdentity?: boolean; deferSleep?: boolean } = {}): MemoryRecord[] {
    try { if (memoryConsent() !== "on") return []; } catch { return []; }
    this.batch++;
    try {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => (m && typeof m === "object" ? (m as { role?: string }).role : "") !== "system");
    const out: MemoryRecord[] = [];
    const items = list.map((m) => ({ role: String((m && typeof m === "object" ? (m as { role?: string }).role : "") || "user"), text: convBlob([m]).trim().replace(/\s+/g, " ") })).filter((i) => i.text);
    const batchLive = new Map<string, string>();
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const safe = this.persistText(stripMemoryPacket(it.text));
      const lane = encodeLane(it.text);
      if (lane === "icl" || lane === "narrative") {
        let text = safe;
        if (lane === "narrative" && opts.keepLiveIdentity) {
          try { text = omitConflictingIdentity(text, this.semantic()); } catch {}
        }
        if (text && !this.seenLower.has(text.toLowerCase())) {
          const rec = this.remember(text, {
            kind: lane === "narrative" ? "episode" : "fact",
            lane,
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
      const before = out.length;
      let coveredChars = 0;
      let skippedIdentity = false;
      for (const raw of extractDurable(it.text)) {
        let text = raw;
        try {
          const asserted = objectAsserted(text);
          if (asserted && /\b(?:instead of|rather than)\b/i.test(text)) {
            text = asserted.p === "uses" ? `Use ${asserted.o}.` : `The ${asserted.s} is ${asserted.o}.`;
          }
        } catch {}
        text = this.persistText(text);
        try {
          const fact = objectAsserted(text);
          if (fact) {
            const store = this.semantic();
            const live = store.get(fact.s, fact.p);
            if (opts.keepLiveIdentity) {
              const obj = fact.o.trim().toLowerCase();
              const slot = `${fact.s}\0${fact.p}`;
              const fromBatch = batchLive.get(slot);
              if (!(fromBatch && fromBatch !== obj)) {
                if (live && live.o.trim().toLowerCase() !== obj) { skippedIdentity = true; continue; }
                if (store.supersededObject(fact.o)) { skippedIdentity = true; continue; }
              }
            }
            const serial = leadingSerial(text);
            if (!(serial == null && live && live.t < 1e11 && !batchLive.has(`${fact.s}\0${fact.p}`))) {
              if (!STATUS_OBJECT.test(fact.o)) {
                store.put(fact.s, fact.p, fact.o, serial ?? Date.now());
                batchLive.set(`${fact.s}\0${fact.p}`, fact.o.trim().toLowerCase());
              }
            }
          }
        } catch {}
        if (this.seenLower.has(text.toLowerCase())) continue;
        const pin = ((t) => !/\b(?:don'?t|do not|never)\s+remember\b/i.test(t) && (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(t) || /\balways\s+\S/i.test(t)))(text);
        const asQuestion = /^\s*(?:what|which|who|where|when|why|how)\b/i.test(text);
        let kind: MemoryKind = asQuestion ? "episode" : pin ? "constraint" : /\b(prefer|never |always |don'?t |do not |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b/i.test(text) || (/\bflake\b/i.test(text) && /\.[A-Za-z]{1,12}\b/.test(text)) ? "episode" : "fact";
        if (kind === "fact" && !asQuestion && !pin) {
          try { if (!objectAsserted(text)) kind = "episode"; } catch { kind = "episode"; }
        }
        out.push(this.remember(text, { kind, pin }));
        coveredChars += text.length;
      }
      try {
        if (!skippedIdentity && !isNoopCue(it.text) && !CHAT.test(it.text.trim()) && safe.length >= 8) {
          let identityTurn = false;
          try { identityTurn = !!objectAsserted(safe); } catch {}
          if (!(opts.keepLiveIdentity && identityTurn)) {
            const cover = coveredChars / Math.max(1, safe.length);
            if (out.length === before || cover < 0.85) {
              const key = safe.replace(/[.!?]+$/g, "").toLowerCase();
              const dup = this.seenLower.has(safe.toLowerCase())
                || out.some((r) => r.text.replace(/[.!?]+$/g, "").toLowerCase() === key)
                || [...this.seenLower].some((s) => s.replace(/[.!?]+$/g, "") === key);
              if (!dup) {
                out.push(this.remember(safe, { kind: "episode" }));
              }
            }
          }
        }
      } catch {}
    }
    return out;
    } finally {
      this.batch--;
      this.flush(false);
      if (!opts.deferSleep) {
        try { noteSleepActivity(this); } catch {}
        try { scheduleIncrementalSleep(this, { session: this.session }); } catch {}
      }
    }
  }

  private flush(mark: boolean) {
    if (mark) this.dirty = true;
    if (this.batch || !this.dirty) return;
    this.persist();
  }

  private persist() {
    try { if (memoryConsent() !== "on") return; } catch { return; }
    try {
      withFileLock(`${this.path}.lock`, () => {
        try {
          const mine = new Set(this.compiled.map((c) => c.rec.id));
          const disk = load(this.path);
          const byId = new Map<string, Compiled>();
          for (const c of disk) {
            if (!mine.has(c.rec.id) && this.knownIds.has(c.rec.id)) continue;
            byId.set(c.rec.id, c);
          }
          for (const c of this.compiled) byId.set(c.rec.id, c);
          this.compiled = [...byId.values()];
          for (const c of this.compiled) this.knownIds.add(c.rec.id);
        } catch {}
        try { this.trimToStoreCap(); } catch {}
        writeFileAtomic(this.path, this.compiled.map((x) => {
          const r = x.rec;
          if ((r.kind === "episode" || !r.kind) && !r.tags && !r.lane && !r.agent && !r.project && !r.ep && !r.invalidAt && !r.validUntil && !r.heat && !r.sal)
            return JSON.stringify([r.id, r.text]);
          return JSON.stringify(r.kind === "episode" ? { ...r, kind: undefined } : r);
        }).join("\n") + (this.compiled.length ? "\n" : ""));
        try { chmodSync(this.path, 0o600); } catch {}
        try { unlinkSync(`${this.path}.wal`); } catch {}
      });
      try { this.rebuildSeen(); } catch {}
      this.dirty = false;
    } catch {
    }
  }

  /** Persist-only. Sleep heat does not call this. Pins/constraints kept; oldest unpinned dropped. */
  private trimToStoreCap(): void {
    const cap = memoryStoreCap();
    if (!Number.isFinite(cap) || cap <= 0 || this.compiled.length <= cap) return;
    const pinned = (r: MemoryRecord) => (r.tags ?? []).includes("pin") || r.kind === "constraint";
    const keep: Compiled[] = [];
    const rest: Compiled[] = [];
    for (const c of this.compiled) (pinned(c.rec) ? keep : rest).push(c);
    rest.sort((a, b) => a.rec.at - b.rec.at);
    const room = Math.max(0, cap - keep.length);
    const keptRest = rest.slice(Math.max(0, rest.length - room));
    const next = keep.concat(keptRest);
    if (next.length === this.compiled.length) return;
    this.compiled = next;
    this.post = null;
  }

  relevant(text: string, cap = memoryRetrieveCap()): MemoryRecord[] {
    if (!String(text ?? "").trim() || isNoopCue(text)) return [];
    const hay = queryHay(text);
    try {
      this.ensureIndex();
      const toks = [...hay].filter((t) => t.length >= 3 && !STOP.has(t));
      const ranked = toks
        .map((t) => ({ t, df: this.post!.get(t)?.length ?? 0 }))
        .filter((x) => x.df > 0)
        .sort((a, b) => a.df - b.df);
      const poolCap = Math.max(cap * 6, 30);
      const seen = new Set<Compiled>();
      const pool: Compiled[] = [];
      for (const { t, df } of ranked) {
        if (df >= 80 && pool.length) break;
        for (const c of this.post!.get(t) ?? []) {
          if (seen.has(c)) continue;
          seen.add(c);
          pool.push(c);
          if (pool.length >= poolCap) break;
        }
        if (df >= 80 || pool.length >= poolCap) break;
      }
      const scored: { rec: MemoryRecord; n: number; rare: number }[] = [];
      for (const c of pool) {
        let n = 0;
        let rare = 0;
        for (const x of c.needles) {
          if (!hay.has(x)) continue;
          n++;
          const df = this.post?.get(x)?.length ?? 1;
          rare += 1 / Math.max(1, df);
        }
        if (n && c.needles.length <= 12 && isLiveRow(c.rec) && !c.needles.some((x) => !hay.has(x) && /^[a-z]+\d+[a-z]$/.test(x)) && !/\b(?:is|are)\s+not\b|\bunrelated\b|\bred herring\b/i.test(c.rec.text))
          scored.push({ rec: c.rec, n, rare });
      }
      return liveCopulaLatest(scored).sort((a, b) =>
        (b.n + rankKindBoost(b.rec)) - (a.n + rankKindBoost(a.rec))
        || b.rare - a.rare
        || b.rec.at - a.rec.at
      ).slice(0, Math.max(0, Math.floor(Number(cap) || 0))).map((x) => x.rec);
    } catch {
      return [];
    }
  }

  notesFor(text = "", k = memoryRetrieveCap()): MemoryRecord[] {
    if (!text) return [];
    const cap = Math.max(0, Math.floor(Number(k) || 0));
    const route = routeMemory(text);
    let recs: MemoryRecord[] = [];
    if (route === "icl-index") {
      recs = mergeIclLane([], text, cap, this.dir, this.compiled.map((c) => c.rec));
    } else {
      recs = this.relevant(text, k);
      if (route === "gist-chunk") recs = mergeNarrativeLane(recs, text, cap, this.dir, this.compiled.map((c) => c.rec));
      recs = mergeHowtoLane(recs, text, cap, this.dir);
    }
    const kept = recs.map((n) => {
      const raw = String(n.text ?? "");
      if (!/\b(?:instead of|rather than)\b/i.test(raw)) return n;
      try {
        const fact = objectAsserted(raw.replace(/^\[[^\]]+\]\s+/, ""));
        if (!fact) return n;
        return { ...n, text: fact.p === "uses" ? `${fact.s} uses ${fact.o}.` : `The ${fact.s} is ${fact.o}.` };
      } catch { return n; }
    });
    try {
      return kept.map((r) => {
        const stripped = stripPacketLabel(r.text).body;
        return { ...r, text: applyProvenanceLabel(r, capMemoryBody(r, stripped)) };
      });
    } catch {
      return kept;
    }
  }

  inject(messages: unknown[]): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      try { if (memoryConsent() === "off") return list; } catch { return list; }
      const blob = convBlob(list);
      const notes: { role: "system"; content: string }[] = [];
      const cue = attachPlaceCues(cueFor(list), placePathsFrom(list));
      if (!blob.includes(MEMORY_MARK)) {
        let silent = false;
        try {
          if (cue && isNoopCue(cue)) silent = true;
          else if (hookLane(cue) === "none") silent = true;
        } catch {}
        const retrieved = !silent && cue ? this.notesFor(cue) : [];
        let packet = retrieved;
        try {
          if (retrieved.length && cue && routeMemory(cue) === "sf-assemble") packet = assembleNotes(retrieved, this.dir);
        } catch {}
        if (packet.length) {
          try { logMemoryNotes(packet); } catch {}
          const packed = packNotes(packet, PACKET_BYTE_CAP, Math.min(PACKET_BULLET_MAX, memoryRetrieveCap()));
          if (packed.length) notes.push({ role: "system", content: MEMORY_MARK + packed.map((m) => `\n- ${m.text}`).join("") });
        }
      }
      try {
        const skipStore = !cue || isNoopCue(cue) || /^(?:what|which|who|where|when|why|how)\b/i.test(cue.trim());
        if (!skipStore) this.observe(list, { deferSleep: true });
      } catch {}
      if (!notes.length) return list;
      const next = list.slice(), i = next.findIndex((m) => (m as { role?: string })?.role !== "system");
      return next.splice(i < 0 ? next.length : i, 0, ...notes), next;
    } catch {
      memoryInjectSwallows.n++;
      return list; // pass-through
    }
  }

  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    try { if (memoryConsent() === "off") return body; } catch { return body; }
    const key = Array.isArray(body.messages) ? "messages" : Array.isArray(body.contents) ? "contents" : "messages";
    const m = Array.isArray(body[key]) ? (body[key] as unknown[]) : [];
    const sys = body.systemInstruction ?? body.system_instruction ?? body.system ?? body.system_prompt ?? body.systemPrompt;
    try {
      const paths = placePathsFrom(body);
      let msgs = m;
      if (paths.length) {
        msgs = m.slice();
        let idx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const o = msgs[i];
          if (!o || typeof o !== "object") continue;
          const role = String((o as { role?: unknown }).role ?? "").toLowerCase();
          if (role === "user" || role === "human") { idx = i; break; }
        }
        if (idx >= 0) {
          const last = { ...(msgs[idx] as Record<string, unknown>) };
          const existing = placePathsFrom(last);
          last.open_files = [...existing, ...paths];
          msgs[idx] = last;
        }
      }
      const next = this.inject(msgs);
      if (sys) {
        try {
          this.observe(typeof sys === "string" ? [{ role: "user", content: sys }] : Array.isArray(sys) ? sys : [sys], { keepLiveIdentity: true });
        } catch {}
      }
      if (next === m) return body;
      return { ...body, [key]: next };
    } catch {
      memoryInjectSwallows.n++;
      return body; // pass-through
    }
  }

  /** One JSONL flush after many observes. Nested with SemanticStore quiet. */
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
    this.compiled = this.compiled.filter((c) => !pred(c.rec));
    this.post = null;
    this.flush(true);
  }

  rewriteWhere(pred: (r: MemoryRecord) => string | undefined): void {
    let dirty = false;
    this.compiled = this.compiled.map((c) => {
      const next = pred(c.rec);
      if (typeof next !== "string" || next === c.rec.text) return c;
      dirty = true;
      return compileNeedles({ ...c.rec, text: next });
    });
    if (dirty) this.post = null, this.flush(true);
  }

  patchWhere(fn: (r: MemoryRecord) => MemoryRecord | undefined): void {
    let dirty = false;
    this.compiled = this.compiled.map((c) => {
      let next: MemoryRecord | undefined;
      try { next = fn(c.rec); } catch { return c; }
      if (!next || next === c.rec) return c;
      dirty = true;
      return compileNeedles(next);
    });
    if (dirty) this.post = null, this.flush(true);
  }

  close() {
    this.flush(false);
  }

  /** Idle/Stop only. Inject must not await this. */
  async sleep(opts?: { session?: string }): Promise<void> {
    try {
      const { consolidate } = await import("./sleep");
      consolidate(this, { session: opts?.session ?? this.session, mode: "full" });
    } catch {}
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

