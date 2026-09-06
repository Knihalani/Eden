import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alreadyInjected, injectFromRequest, injectNote } from "../packages/know/src/inject";
import { knowQuery } from "../packages/know/src/query";
import { messageText } from "../packages/wrap/src/intent";

export const MEMORY_MARK = "Eden Memory:";

export type MemoryKind = "fact" | "preference" | "episode" | "procedure" | "constraint" | string;

export type MemoryRecord = {
  id: string;
  text: string;
  kind: MemoryKind;
  tags: string[];
  agent?: string;
  at: number;
};

export type KnowSearch = {
  search(q: string, k?: number): { s: string; p: string; o: string; e: string; url?: string }[];
  close?: () => void;
};

export type MemoryOptions = {
  dir?: string;
  know?: KnowSearch;
  agent?: string;
};

export type QueryHit = {
  text: string;
  source: "memory" | "know";
  url?: string;
  id?: string;
};

type Compiled = { rec: MemoryRecord; needles: string[] };
type Note = { role: "system"; content: string };

const STOP = new Set([
  "the", "of", "is", "a", "an", "on", "to", "and", "in", "for", "this", "that", "with", "from",
  "into", "about", "these", "then", "still", "has", "out", "please", "how", "should", "what",
  "why", "was", "are", "you", "your", "its", "our", "not", "never", "use", "used", "just",
  "last", "week", "down", "look", "next", "need", "before", "merge", "prefers", "user",
  "memory", "ran", "fact", "such", "or", "no", "and", "app",
]);

function memDir(dir?: string): string {
  return dir || join(homedir(), ".eden", "memory");
}

function fileOf(dir: string): string {
  return join(dir, "memories.jsonl");
}

function nid(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function tokList(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [];
}

function compile(rec: MemoryRecord): Compiled {
  const seen = new Set<string>();
  const needles: string[] = [];
  const add = (w: string) => {
    if (!w || seen.has(w)) return;
    seen.add(w);
    needles.push(w);
  };
  for (const t of rec.tags) add(t.toLowerCase());
  for (const w of tokList(rec.text)) {
    if (w.length >= 4 && !STOP.has(w)) add(w);
  }
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
      if (rec && rec.id && rec.text) out.push(compile(rec));
    } catch {}
  }
  return out;
}

function persistAll(path: string, rows: Compiled[]) {
  writeFileSync(path, rows.map((c) => JSON.stringify(c.rec)).join("\n") + (rows.length ? "\n" : ""));
}

function hits(hay: Set<string>, compiled: Compiled[]): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  for (const c of compiled) {
    for (const n of c.needles) {
      if (hay.has(n)) {
        out.push(c.rec);
        break;
      }
    }
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

  constructor(opts: MemoryOptions = {}) {
    this.dir = memDir(opts.dir);
    this.know = opts.know;
    this.agent = opts.agent;
    mkdirSync(this.dir, { recursive: true });
    this.path = fileOf(this.dir);
    this.compiled = load(this.path);
  }

  memories(): MemoryRecord[] {
    return this.compiled.map((c) => c.rec);
  }

  remember(text: string, opts: { kind?: MemoryKind; tags?: string[]; id?: string; agent?: string } = {}): MemoryRecord {
    const rec: MemoryRecord = {
      id: opts.id || nid(),
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
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.path, JSON.stringify(rec) + "\n");
    this.cache.clear();
    return rec;
  }

  forget(id: string): boolean {
    const n = this.compiled.length;
    this.compiled = this.compiled.filter((c) => c.rec.id !== id);
    if (this.compiled.length === n) return false;
    persistAll(this.path, this.compiled);
    this.cache.clear();
    return true;
  }

  relevant(text: string, cap = 6): MemoryRecord[] {
    const hay = new Set(tokList(text));
    const found = hits(hay, this.compiled);
    return found.length > cap ? found.slice(0, cap) : found;
  }

  query(q: string, k = 5): QueryHit[] {
    const qn = q.trim();
    const out: QueryHit[] = [];
    if (qn) {
      for (const m of this.relevant(qn, k)) {
        out.push({ text: m.text, source: "memory", id: m.id });
      }
    }
    try {
      const card = knowQuery(qn, this.know);
      if (card && "fact" in card && card.fact) out.push({ text: card.fact, source: "know", url: card.url });
    } catch {}
    return out.slice(0, k);
  }

  inject(messages: unknown[]): unknown[] {
    const list = Array.isArray(messages) ? messages : [];
    try {
      const blob = messageText(list);
      let notes = this.cache.get(blob);
      if (!notes) {
        if (alreadyInjected(blob) || blob.includes(MEMORY_MARK)) {
          this.cache.set(blob, []);
          return list;
        }
        const mems = this.relevant(blob);
        const card = injectFromRequest({ text: blob }, this.know);
        notes = [];
        if (mems.length) {
          let body = MEMORY_MARK;
          for (const m of mems) body += `\n- ${m.text}`;
          notes.push({ role: "system", content: body });
        }
        if (card) notes.push({ role: "system", content: injectNote(card) });
        if (this.cache.size > 256) this.cache.clear();
        this.cache.set(blob, notes);
      }
      if (!notes.length) return list;
      const next = list.slice();
      let i = 0;
      while (i < next.length && (next[i] as { role?: string })?.role === "system") i++;
      next.splice(i, 0, ...notes);
      return next;
    } catch {
      return list;
    }
  }

  injectBody(body: Record<string, unknown>): Record<string, unknown> {
    const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
    return { ...body, messages: this.inject(messages) };
  }

  close() {}
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

export function host(opts: MemoryOptions & { port?: number } = {}) {
  const memory = openMemory(opts);
  const server = Bun.serve({
    port: opts.port ?? 8787,
    async fetch(req) {
      const u = new URL(req.url);
      try {
        if (req.method === "POST" && u.pathname === "/remember") {
          const b = (await req.json()) as { text?: string; kind?: string; tags?: string[]; id?: string };
          return Response.json(memory.remember(String(b.text || ""), b));
        }
        if (req.method === "POST" && u.pathname === "/forget") {
          const b = (await req.json()) as { id?: string };
          return Response.json({ ok: memory.forget(String(b.id || "")) });
        }
        if (req.method === "POST" && u.pathname === "/inject") {
          const b = (await req.json()) as { messages?: unknown[] };
          return Response.json({ messages: memory.inject(b.messages || []) });
        }
        if (req.method === "GET" && u.pathname === "/query") {
          return Response.json(memory.query(u.searchParams.get("q") || ""));
        }
        if (req.method === "GET" && u.pathname === "/memories") {
          return Response.json(memory.memories());
        }
        return new Response("eden memory\n", { status: 200 });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 400 });
      }
    },
  });
  return { url: String(server.url), stop: () => server.stop(), memory };
}
