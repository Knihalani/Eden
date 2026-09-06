import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alreadyInjected, injectFromRequest, injectNote } from "../packages/know/src/inject";
import { knowQuery } from "../packages/know/src/query";

export const MEMORY_MARK = "Eden Memory:";

export type MemoryKind = "fact" | "preference" | "episode" | "procedure" | "constraint" | string;
export type MemoryRecord = { id: string; text: string; kind: MemoryKind; tags: string[]; agent?: string; at: number };
export type KnowSearch = { search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[]; close?: () => void };
export type MemoryOptions = { dir?: string; know?: KnowSearch; agent?: string };
export type QueryHit = { text: string; source: "memory" | "know"; url?: string; id?: string };

type Compiled = { rec: MemoryRecord; needles: string[] };
type Note = { role: "system"; content: string };

const STOP = new Set(["the","of","is","a","an","on","to","and","in","for","this","that","with","from","into","about","these","then","still","has","out","please","how","should","what","why","was","are","you","your","its","our","not","never","use","used","just","last","week","down","look","next","need","before","merge","prefers","user","memory","ran","fact","such","or","no","app"]);

function tokList(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [];
}

function convBlob(list: unknown[]): string {
  if (list.length === 1) {
    const o = list[0] as Record<string, unknown> | undefined;
    if (o && typeof o.content === "string" && !(o.reasoning_content || o.thinking || o.reasoning)) return o.content;
  }
  const parts: string[] = [];
  for (const m of list) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const c = o.content;
    if (typeof c === "string") {
      if (c) parts.push(c);
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === "object") {
          const t = (b as { text?: string }).text;
          if (t) parts.push(t);
        }
      }
    }
    const r = o.reasoning_content ?? o.thinking ?? o.reasoning;
    if (typeof r === "string" && r) parts.push(r);
  }
  return parts.join("\n");
}

function compile(rec: MemoryRecord): Compiled {
  const seen = new Set<string>();
  const needles: string[] = [];
  const add = (w: string) => {
    if (w && !seen.has(w)) {
      seen.add(w);
      needles.push(w);
    }
  };
  for (const t of rec.tags) add(t.toLowerCase());
  for (const w of tokList(rec.text)) if (w.length >= 4 && !STOP.has(w)) add(w);
  return { rec, needles };
}

function load(path: string): Compiled[] {
  if (!existsSync(path)) return [];
  const out: Compiled[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t) as MemoryRecord;
      if (rec?.id && rec.text) out.push(compile(rec));
    } catch {}
  }
  return out;
}

export class AgentMemory {
  readonly dir: string;
  private know?: KnowSearch;
  private agent?: string;
  private compiled: Compiled[];
  private path: string;
  private cache = new Map<string, Note[]>();
  private out = new WeakMap<object, unknown[]>();

  constructor(opts: MemoryOptions = {}) {
    this.dir = opts.dir || join(homedir(), ".eden", "memory");
    this.know = opts.know;
    this.agent = opts.agent;
    mkdirSync(this.dir, { recursive: true });
    this.path = join(this.dir, "memories.jsonl");
    this.compiled = load(this.path);
  }

  memories(): MemoryRecord[] {
    return this.compiled.map((c) => c.rec);
  }

  remember(text: string, opts: { kind?: MemoryKind; tags?: string[]; id?: string; agent?: string } = {}): MemoryRecord {
    const rec: MemoryRecord = {
      id: opts.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      text: String(text || "").trim(),
      kind: opts.kind || "fact",
      tags: (opts.tags || []).map((t) => t.toLowerCase()),
      agent: opts.agent || this.agent,
      at: Date.now(),
    };
    if (!rec.text) return rec;
    const c = compile(rec);
    const i = this.compiled.findIndex((x) => x.rec.id === rec.id);
    if (i >= 0) this.compiled[i] = c;
    else this.compiled.push(c);
    this.persist();
    return rec;
  }

  forget(id: string): boolean {
    const n = this.compiled.length;
    this.compiled = this.compiled.filter((c) => c.rec.id !== id);
    if (this.compiled.length === n) return false;
    this.persist();
    return true;
  }

  private persist() {
    writeFileSync(this.path, this.compiled.map((x) => JSON.stringify(x.rec)).join("\n") + (this.compiled.length ? "\n" : ""));
    this.cache.clear();
    this.out = new WeakMap();
  }

  relevant(text: string, cap = 6): MemoryRecord[] {
    const hay = new Set(tokList(text));
    const out: MemoryRecord[] = [];
    for (const c of this.compiled) {
      if (this.agent && c.rec.agent && c.rec.agent !== this.agent) continue;
      for (const n of c.needles) {
        if (hay.has(n)) {
          out.push(c.rec);
          break;
        }
      }
      if (out.length >= cap) break;
    }
    return out;
  }

  query(q: string, k = 5): QueryHit[] {
    const qn = q.trim();
    const out: QueryHit[] = [];
    if (qn) for (const m of this.relevant(qn, k)) out.push({ text: m.text, source: "memory", id: m.id });
    try {
      const card = knowQuery(qn, this.know);
      if (card && "fact" in card && card.fact) out.push({ text: card.fact, source: "know", url: card.url });
    } catch {}
    return out.slice(0, k);
  }

  inject(messages: unknown[]): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    const hit = this.out.get(list);
    if (hit) return hit;
    try {
      const blob = convBlob(list);
      let notes = this.cache.get(blob);
      if (!notes) {
        notes = [];
        if (!alreadyInjected(blob) && !blob.includes(MEMORY_MARK)) {
          const mems = this.relevant(blob);
          if (mems.length) {
            let body = MEMORY_MARK;
            for (const m of mems) body += `\n- ${m.text}`;
            notes.push({ role: "system", content: body });
          }
          const card = injectFromRequest({ text: blob }, this.know);
          if (card) notes.push({ role: "system", content: injectNote(card) });
        }
        if (this.cache.size > 256) this.cache.clear();
        this.cache.set(blob, notes);
      }
      const next = notes.length ? list.slice() : list;
      if (notes.length) {
        let i = 0;
        while (i < next.length && (next[i] as { role?: string })?.role === "system") i++;
        next.splice(i, 0, ...notes);
      }
      this.out.set(list, next);
      return next;
    } catch {
      return list;
    }
  }

  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
    const next = this.inject(messages);
    return next === messages ? body : { ...body, messages: next };
  }
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

let proc: AgentMemory | undefined;
export function processMemory(): AgentMemory {
  return (proc ??= openMemory({ dir: process.env.EDEN_MEMORY_DIR }));
}

export function host(opts: MemoryOptions & { port?: number } = {}) {
  const memory = openMemory(opts);
  const server = Bun.serve({
    port: opts.port ?? 8787,
    async fetch(req) {
      try {
        const p = new URL(req.url).pathname;
        if (req.method === "POST") {
          const b = (await req.json()) as { text?: string; kind?: string; tags?: string[]; id?: string; messages?: unknown[] };
          if (p === "/remember") return Response.json(memory.remember(String(b.text || ""), b));
          if (p === "/forget") return Response.json({ ok: memory.forget(String(b.id || "")) });
          if (p === "/inject") return Response.json({ messages: memory.inject(b.messages || []) });
        }
        if (req.method === "GET" && p === "/query") return Response.json(memory.query(new URL(req.url).searchParams.get("q") || ""));
        if (req.method === "GET" && p === "/memories") return Response.json(memory.memories());
        return new Response("eden memory\n");
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 400 });
      }
    },
  });
  return { url: String(server.url), stop: () => server.stop(), memory };
}
