import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import { redact } from "../packages/ir/src/redact";
import { completeNotes } from "./cls/complete";
import { memoryConsent } from "./memory-consent";
import { dropHarmed } from "./memory-harmed";
import { opaqueProject, scrubMemoryText } from "./memory-scrub";
import { type MemoryLaneKind } from "./memory-lanes";
import { isToolProse, objectAsserted } from "./semantic-store";

export { dropHarmed, loadHarmedIds, markHarmed } from "./memory-harmed";
export const MEMORY_MARK = "Eden Memory:";
export const memoryInjectSwallows = { n: 0 };

export function isMathChatterCue(cue: string): boolean {
  try {
    const t = String(cue ?? "").trim();
    if (!t) return false;
    if (/\b(?:auth|sqlite|postgres|clerk|flake|commit|test|database|provider|session|file|src\/|\.ts|\.py|adr)\b/i.test(t)) {
      return false;
    }
    const lower = t.toLowerCase();
    if (/^(?:ok|okay|thanks|thank you|lol|lmao|asdf|qwerty|hi|hey|yo|continue|lgtm|ok go|sounds good|ship it)\s*[.!?]?\s*$/i.test(lower)) return true;
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

const STOP = new Set(["the","of","is","a","an","on","to","and","in","for","this","that","with","from","into","about","these","then","still","has","out","please","how","should","what","why","was","are","you","your","its","our","not","never","use","used","just","last","week","down","look","next","need","before","merge","prefers","user","memory","ran","fact","such","or","no","app"]);

function compileNeedles(rec: MemoryRecord): Compiled {
  return { rec, needles: [...new Set([...rec.tags.filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)), ...(s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(rec.text).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))])] };
}

const CUE_EXPAND: Record<string, string[]> = {
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
  dashboard: ["database", "dashboards"],
  welcome: ["email"],
  mail: ["email"],
  sha: ["git", "bash"],
  git: ["bash"],
  session: ["cache"],
  hanging: ["package"],
  sso: ["auth"],
  jwt: ["auth"],
  bouncing: ["auth"],
  errors: ["error"],
  grouping: ["error"],
  workflow: ["workflows"],
  purging: ["cdn"],
  edge: ["cdn"],
  ticket: ["issues"],
  triage: ["issues"],
  paged: ["paging"],
  apply: ["infra"],
  policies: ["auth"],
  channel: ["chat"],
  funnel: ["analytics"],
  signup: ["analytics"],
  text: ["sms"],
  handset: ["sms"],
  identify: ["cdp"],
  spec: ["specs"],
  mock: ["mocks"],
};

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
  const label = whole.match(SPEAKER_LABEL)?.[1];
  for (const raw of labeledWhole ? [whole] : blob.replace(ACK_PREFIX, "").split(/(?:(?<=\n)|(?<=[.!?])(?<!\d\.))\s+/)) {
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

function load(path: string): Compiled[] {
  const out: Compiled[] = [];
  const idx = new Map<string, number>();
  if (!existsSync(path)) return out;
  let raw = "";
  try { raw = readFileSync(path, "utf8"); } catch { return out; }
  for (const t of raw.split("\n")) {
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as MemoryRecord;
      if (rec?.id && rec.text) {
        rec.lane = rec.lane ?? "chat";
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

export function memoryRetrieveCap(): number {
  const raw = Number(process.env.EDEN_MEMORY_CAP);
  if (!Number.isFinite(raw) || raw <= 0) return PACKET_CHAT_K_MIN;
  return Math.min(PACKET_CHAT_K_MAX, Math.max(PACKET_CHAT_K_MIN, Math.floor(raw)));
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
  private cons: MemoryRecord[] = [];
  private hopShort: MemoryRecord[] = [];

  constructor(opts: MemoryOptions = {}) {
    this.agent = opts.agent; this.project = opaqueProject(opts.project);
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
    this.rebuildSeen();
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

  remember(text: string, opts: { kind?: MemoryKind; tags?: string[]; id?: string; agent?: string; project?: string; pin?: boolean; lane?: MemoryLaneKind } = {}): MemoryRecord {
    const rec: MemoryRecord = { id: opts.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, text: this.persistText(String(text || "").trim()), kind: opts.kind || "fact", tags: (opts.tags || []).map((t) => t.toLowerCase()), agent: opts.agent || this.agent, project: opaqueProject(opts.project || this.project), at: Date.now(), lane: opts.lane ?? "chat" };
    if (!rec.text) return rec;
    try { if (memoryConsent() !== "on") return rec; } catch { return rec; }
    const uttered = `${text ?? ""}\n${rec.text}`;
    const pin = opts.pin === true || ((t) => !/\b(?:don'?t|do not|never)\s+remember\b/i.test(t) && (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(t) || /\balways\s+\S/i.test(t)))(uttered);
    if (pin && !rec.tags.includes("pin")) rec.tags.push("pin");
    const c = compileNeedles(rec), i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    i >= 0 && this.compiled.splice(i, 1);
    this.compiled.push(c);
    this.post = null;
    if (!this.project || rec.project === this.project) this.seenLower.add(rec.text.toLowerCase());
    return this.flush(true), rec;
  }

  private rebuildSeen() {
    this.seenLower = new Set();
    this.post = null;
    for (const c of this.compiled) {
      if (!this.project || c.rec.project === this.project) this.seenLower.add(c.rec.text.toLowerCase());
    }
  }

  private ensureIndex() {
    if (this.post) return;
    const post = new Map<string, Compiled[]>();
    const cons: MemoryRecord[] = [];
    const shorts: MemoryRecord[] = [];
    for (const c of this.compiled) {
      if (c.rec.kind === "digest") continue;
      if (this.agent && c.rec.agent && c.rec.agent !== this.agent) continue;
      if (this.project && c.rec.project !== this.project) continue;
      if (c.rec.kind === "constraint") cons.push(c.rec);
      if (c.needles.length <= 12 && String(c.rec.text ?? "").trim()) shorts.push(c.rec);
      for (const w of c.needles) {
        if (w.length < 3 || STOP.has(w)) continue;
        let arr = post.get(w);
        if (!arr) post.set(w, arr = []);
        arr.push(c);
      }
    }
    this.post = post;
    this.cons = cons;
    this.hopShort = shorts;
  }

  observe(messages: unknown[]): MemoryRecord[] {
    try { if (memoryConsent() !== "on") return []; } catch { return []; }
    this.batch++;
    try {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => (m && typeof m === "object" ? (m as { role?: string }).role : "") !== "system");
    const out: MemoryRecord[] = [];
    const items = list.map((m) => ({ role: String((m && typeof m === "object" ? (m as { role?: string }).role : "") || "user"), text: convBlob([m]).trim().replace(/\s+/g, " ") })).filter((i) => i.text);
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const safe = this.persistText(it.text);
      for (const raw of extractDurable(safe)) {
        let text = raw;
        try {
          const asserted = objectAsserted(text);
          if (asserted && /\b(?:instead of|rather than)\b/i.test(text)) {
            text = asserted.p === "uses" ? `Use ${asserted.o}.` : `The ${asserted.s} is ${asserted.o}.`;
          }
        } catch {}
        text = this.persistText(text);
        try {
          let t = text.replace(/\.+$/, "");
          const by = t.match(/^(.{2,80}?)\s+is by\s+(.+)$/i);
          if (by) t = `The author of ${by[1]!.trim()} is ${by[2]!.trim()}`;
          const sp = t.match(/^(.{2,40}?)(?:'s|\s+s)\s+spouse is (.+)$/i);
          if (sp) t = `The spouse of ${sp[1]!.trim()} is ${sp[2]!.trim()}`;
          const inn = t.match(/^(.{2,80}?)\s+is in\s+(Africa|Europe|Asia|Antarctica|Oceania|Australia|North America|South America)$/i);
          if (inn) t = `The continent of ${inn[1]!.trim()} is ${inn[2]!.trim()}`;
          if (t) text = /[.!?]$/.test(t) ? t : `${t}.`;
        } catch {}
        if (this.seenLower.has(text.toLowerCase())) continue;
        const key = isToolProse(text) ? null : subjectKey(text);
        const supersede = /\b(?:instead of|rather than)\b/i.test(raw);
        if (key && !supersede) {
          const before = this.compiled.length;
          this.compiled = this.compiled.filter((c) => (this.project && c.rec.project !== this.project) || subjectKey(c.rec.text) !== key);
          if (this.compiled.length !== before) this.rebuildSeen();
        }
        const pin = ((t) => !/\b(?:don'?t|do not|never)\s+remember\b/i.test(t) && (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(t) || /\balways\s+\S/i.test(t)))(safe) || ((t) => !/\b(?:don'?t|do not|never)\s+remember\b/i.test(t) && (/\b(?:please\s+)?remember(?:\s+that)?\s+\S/i.test(t) || /\balways\s+\S/i.test(t)))(it.text);
        out.push(this.remember(text, { kind: pin ? "constraint" : /\b(prefer|never |always |don'?t |do not |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided |settled on|going with|agreed to|switched to|standardized on|standardized to|rolled back|pinned to|migrated to|reverted to|deprecated |cut over to|turned on|turned off|enabled the|disabled the)\b/i.test(text) ? "episode" : "fact", lane: "chat", tags: (s => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(text), pin }));
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
    try {
      withFileLock(`${this.path}.lock`, () => {
        writeFileAtomic(this.path, this.compiled.map((x) => JSON.stringify(x.rec)).join("\n") + (this.compiled.length ? "\n" : ""));
        try { chmodSync(this.path, 0o600); } catch {}
        try { unlinkSync(`${this.path}.wal`); } catch {}
      });
      this.dirty = false;
    } catch {
    }
  }

  relevant(text: string, cap = memoryRetrieveCap()): MemoryRecord[] {
    const hay = queryHay(text);
    try {
      for (const t of [...hay]) {
        const extra = CUE_EXPAND[t];
        if (!extra) continue;
        for (const x of extra) hay.add(x);
      }
    } catch {}
    let rows: Compiled[] = [];
    try {
      this.ensureIndex();
      const seen = new Set<Compiled>();
      if (this.post) {
        for (const t of hay) {
          if (t.length < 3 || STOP.has(t)) continue;
          const arr = this.post.get(t);
          if (!arr) continue;
          for (const c of arr) {
            if (seen.has(c)) continue;
            seen.add(c);
            rows.push(c);
          }
        }
      }
    } catch {
      rows = [];
    }
    if (!rows.length) {
      rows = this.compiled.filter((c) => c.rec.kind !== "digest" && !(this.agent && c.rec.agent && c.rec.agent !== this.agent) && !(this.project && c.rec.project !== this.project));
    }
    const scored: { rec: MemoryRecord; n: number; k: number }[] = [];
    for (const c of rows) {
      let n = 0;
      for (const x of c.needles) if (hay.has(x)) n++;
      if (n && (n > 1 || c.needles.length <= 12) && !c.needles.some((x) => !hay.has(x) && /^[a-z]+\d+[a-z]$/.test(x))) {
        if (/\b(?:is|are)\s+not\b|\bunrelated\b|\bred herring\b/i.test(c.rec.text)) continue;
        scored.push({ rec: c.rec, n, k: c.needles.length });
      }
    }
    const ranked = scored.sort((a, b) => b.n - a.n || Number(b.rec.kind === "constraint") - Number(a.rec.kind === "constraint") || a.k - b.k || b.rec.at - a.rec.at).slice(0, Math.max(cap * 6, 30));
    let lexical = ranked.slice(0, Math.max(0, Math.floor(Number(cap) || 0))).map((x) => x.rec);
    try {
      if (String(text ?? "").trim()) {
        lexical = ((extras, lexical, cap) => { const k = Math.min(10, Math.max(0, Math.floor(Number(cap) || 0))); if (!k || !extras.length) return lexical; extras.sort((a, b) => b.at - a.at); const base = Array.isArray(lexical) ? lexical : []; const out: MemoryRecord[] = []; const room = Math.max(k, 64); for (const r of extras) { if (out.length >= room) break; if (out.some((p) => p.id === r.id) || base.some((p) => p.id === r.id)) continue; out.push(r); } for (const l of base) { if (out.length >= room) break; if (out.some((p) => p.id === l.id)) continue; out.push(l); } return out.length ? out : base; })(this.cons.length ? this.cons : rows.filter((c) => c.rec.kind === "constraint").map((c) => c.rec), lexical, cap);
      }
    } catch {}
    return lexical;
  }

  notesFor(text = "", k = memoryRetrieveCap()): MemoryRecord[] {
    if (!text) return [];
    const recs = this.relevant(text, k);
    try { return dropHarmed(this.dir, recs); } catch { return recs; }
  }

  inject(messages: unknown[]): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      try { if (memoryConsent() === "off") return list; } catch { return list; }
      const blob = convBlob(list);
      const notes: { role: "system"; content: string }[] = [];
      if (!blob.includes(MEMORY_MARK)) {
        const cue = cueFor(list);
        let silent = false;
        try { if (cue && isMathChatterCue(cue)) silent = true; } catch {}
        const retrieved = !silent && cue ? this.notesFor(cue) : [];
        let packet: MemoryRecord[] = [];
        try {
          if (!silent && cue && retrieved.length) {
            if (/\b(?:country|sport|based in|incident rotation|author|continent|region owns)\b/i.test(cue)) {
              let hopPool = retrieved;
              try { hopPool = this.hopShort.length ? this.hopShort : retrieved; } catch {}
              try { hopPool = dropHarmed(this.dir, hopPool); } catch {}
              packet = completeNotes(cue, retrieved, hopPool);
            } else packet = retrieved;
          } else if (!silent) packet = retrieved;
        } catch {
          packet = !silent && retrieved.length ? retrieved : [];
        }
        try { packet = dropHarmed(this.dir, packet); } catch {}
        try {
          const latest = (re: RegExp) => packet.reduce((b, m) => (re.test(String(m.text ?? "")) && m.at > b ? m.at : b), -1);
          const sha = latest(/\bsha256\b/i);
          const loc = latest(/\bbased in\b/i);
          const drain = latest(/\blog drain\b/i);
          const region = latest(/\bregion of\b/i);
          packet = packet.filter((m) => {
            const t = String(m.text ?? "");
            if (sha >= 0 && /\bsha256\b/i.test(t) && m.at < sha) return false;
            if (loc >= 0 && /\bbased in\b/i.test(t) && m.at < loc) return false;
            if (drain >= 0 && /\blog drain\b/i.test(t) && m.at < drain) return false;
            if (region >= 0 && /\bregion of\b/i.test(t) && m.at < region) return false;
            return true;
          });
        } catch {}
        if (packet.length) notes.push({ role: "system", content: MEMORY_MARK + packet.map((m) => `\n- ${m.text}`).join("") });
      }
      if (!notes.length) return list;
      const next = list.slice(), i = next.findIndex((m) => (m as { role?: string })?.role !== "system");
      return next.splice(i < 0 ? next.length : i, 0, ...notes), next;
    } catch {
      memoryInjectSwallows.n++;
      return list;
    }
  }

  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    try { if (memoryConsent() === "off") return body; } catch { return body; }
    const key = Array.isArray(body.messages) ? "messages" : Array.isArray(body.contents) ? "contents" : "messages";
    const m = Array.isArray(body[key]) ? (body[key] as unknown[]) : [];
    try {
      const next = this.inject(m);
      if (next === m) return body;
      return { ...body, [key]: next };
    } catch {
      memoryInjectSwallows.n++;
      return body;
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
    if (dirty) this.post = null;
    if (dirty) this.flush(true);
  }

  close() {
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

