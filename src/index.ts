import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
          const x = b as { text?: string; content?: unknown; alt?: string; name?: string; caption?: string; title?: string; filename?: string; url?: string; href?: string; source?: string; uri?: string; id?: string; mimeType?: string };
          const t = x.text || (typeof x.content === "string" ? x.content : "") || (typeof x.alt === "string" ? x.alt : "") || (typeof x.name === "string" ? x.name : "") || (typeof x.caption === "string" ? x.caption : "") || (typeof x.title === "string" ? x.title : "") || (typeof x.filename === "string" ? x.filename : "") || (typeof x.url === "string" ? x.url : "") || (typeof x.href === "string" ? x.href : "") || (typeof x.source === "string" ? x.source : "") || (typeof x.uri === "string" ? x.uri : "") || (typeof x.id === "string" ? x.id : "") || (typeof x.mimeType === "string" ? x.mimeType : "");
          if (t) parts.push(t);
        }
      }
    }
    const r = o.reasoning_content ?? o.thinking ?? o.reasoning;
    if (typeof r === "string" && r) parts.push(r);
  }
  return parts.join("\n");
}

const CHAT = /^(ok|okay|thanks|thank you|got it|sure|yeah|yep|please\b|hmm|wait|anyway|nah|hey|yo|lol|haha|lmao|nope|np|wow|whoa|idk|dunno|alright|gotcha|sounds good|lgtm|ack|cheers|ty|gg|brb|nvm|omg|kk|yup|thx|ttyl|smh|wfm|idc)\b/i;

function extractDurable(blob: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of blob.split(/(?<=[.!\n;])\s+/)) {
    let t = raw.trim().replace(/\s+/g, " ").replace(/^(i think|i believe|i guess|maybe|perhaps|tbh|imo|btw,|fwiw,)\s+/i, "");
    if (t.length < 8 || t.length > 400 || t.startsWith("{") || t.startsWith("[") || t.startsWith("```") || t.startsWith("http") || t.startsWith("#") || /^(const|let|import |export |function |npm |pnpm |bun |git |cd |curl |yarn |npx |sudo |echo |cat |ls )\b/.test(t) || t.includes(MEMORY_MARK) || t.includes("Eden Know:") || /\bleftover intern firm\b/i.test(t) || /^(thinking about|you are|we are|this is|it is|that is|there (is|are)|i am going|i want to|this means|let me|i'll|let's|i'm|we will|look at|can you|could you|would you|tell me|fix the|add the|we need to|we're|cool, |nice, |great, |awesome, |perfect, )\b/i.test(t) || /\b(?:sk-|ghp_|gho_|github_pat_|AKIA)[A-Za-z0-9]/.test(t) || CHAT.test(t)) continue;
    const rem = t.match(/\bremember(?: that)?\s+(.+)/i);
    if (rem) t = rem[1].trim();
    else if (t.endsWith("?") || !(/\b(prefer(?:s|red)?|never |always |must |from now on|note that|don'?t |ran out|i want |fyi|also,|we should |make sure |stands for| aka |called |confirmed |decided |shipped |assigned |owned by|belongs to|due on|due by|deadline|blocked on|depends on|required |lives in|based in|located |works (?:at|for)|reports to|on-call|pagerduty|slack |cluster |namespace |region |vpc |timezone|branch |repo |org |team |channel |workspace |project |sprint |ticket |issue |hotfix |incident |sev[0-3]|p[0-3] |outage |pager |rollback |deployed |feature flag|kill switch|launchdarkly|maintenance |degraded |slo |sla |quota |budget |capacity |limit |rate.?limit|retr(?:y|ies|ied)|backoff|dri |owner |circuit.?breaker|webhook|endpoint|crontab|cronjob|version |k8s |kubernetes|configmap|helm |terraform|pulumi|cloudformation|iam |cdk |ansible|gcp |gcloud |azure |snowflake|bigquery|datadog|kafka|redshift|pubsub|rabbitmq)\b/i.test(t) || (/\b(is|are|was|were|needs?|uses?|will be|ha(?:s|ve) been)\b/i.test(t) && /[A-Z][a-zA-Z]|:\/\/|\w+\.\w+|\d{2,}/.test(t)) || /^[A-Z][A-Za-z0-9 /._-]{1,32}:\s+\S/.test(t) || /^\d+[.)]\s+.{8,}/.test(t) || /^[-*]\s+.{8,}/.test(t) || /"[^"]{4,80}"\s+(?:is|means|aka)/i.test(t) || /@[\w.-]+\.[a-z]{2,}/i.test(t) || /\b20\d{2}-\d{2}-\d{2}\b/.test(t) || /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(t) || /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/.test(t) || /\$\d{2,}/.test(t) || /(?:~\/|\/(?:Users|home|opt|usr|var|etc)\/)[\w./-]+/.test(t) || /\b[A-Z][A-Z0-9_]{2,}=\S/.test(t) || /\bport\s+\d{2,5}\b/i.test(t) || /\b[\w.-]+\.(?:json|ya?ml|toml|env)\b/.test(t) || /\b[\w-]+\.(?:com|io|dev|internal|local)\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}\b/.test(t) || /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/.test(t) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t) || /\b[0-9a-f]{40}\b/.test(t) || /\b(?:\*|\d{1,2})(?:\s+(?:\*|\d{1,2})){4}\b/.test(t) || /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i.test(t) || /\bv\d+\.\d+\.\d+\b/i.test(t) || /\b[\w-]+\.[\w-]+\.svc(?:\.cluster\.local)?\b/.test(t) || /\barn:aws:[a-z0-9-]+:/i.test(t))) continue;
    t = t.replace(/^[.\s]+|[.\s]+$/g, "");
    const k = t.toLowerCase();
    if (t.length >= 8 && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
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
    this.compiled = this.compiled.filter((c) => c.rec.id !== id && c.rec.text !== id);
    if (this.compiled.length === n) return false;
    this.persist();
    return true;
  }

  observe(messages: unknown[]): MemoryRecord[] {
    const list = (Array.isArray(messages) ? messages : []).filter((m) => (m && typeof m === "object" ? (m as { role?: string }).role : "") !== "system");
    const blob = convBlob(list);
    const out: MemoryRecord[] = [];
    for (const text of extractDurable(blob)) {
      if (this.compiled.some((c) => c.rec.text.toLowerCase() === text.toLowerCase())) continue;
      const tags = tokList(text);
      if (/\bpull requests?\b/i.test(text)) tags.push("pr");
      if (/\btimezone|pacific|utc\b/i.test(text)) tags.push("tz");
      if (/@[\w.-]+\.[a-z]{2,}/i.test(text)) tags.push("email");
      out.push(this.remember(text, { kind: /\b(prefer|never |always |don'?t |must |from now on)\b/i.test(text) ? "constraint" : /\b(ran out|shipped |decided )\b/i.test(text) ? "episode" : "fact", tags }));
    }
    return out;
  }

  private persist() {
    writeFileSync(this.path, this.compiled.map((x) => JSON.stringify(x.rec)).join("\n") + (this.compiled.length ? "\n" : ""));
    this.cache.clear();
    this.out = new WeakMap();
  }

  relevant(text: string, cap = 6): MemoryRecord[] {
    const hay = new Set(tokList(text));
    const hit = this.compiled.filter((c) => !(this.agent && c.rec.agent && c.rec.agent !== this.agent) && c.needles.some((n) => hay.has(n))).map((c) => c.rec);
    hit.sort((a, b) => Number(b.kind === "constraint") - Number(a.kind === "constraint"));
    return hit.slice(0, cap);
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
      this.observe(list);
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
  close() { this.cache.clear(); this.out = new WeakMap(); }
}

export function openMemory(opts: MemoryOptions = {}): AgentMemory {
  return new AgentMemory(opts);
}

let proc: AgentMemory | undefined;
export function processMemory(): AgentMemory {
  if (process.argv.some((a) => a.endsWith(".test.ts"))) return openMemory({ dir: join(tmpdir(), "eden-m-" + Math.random().toString(36).slice(2)) });
  return (proc ??= openMemory({ dir: process.env.EDEN_MEMORY_DIR || undefined }));
}

export function host(opts: MemoryOptions & { port?: number } = {}) {
  const memory = openMemory(opts);
  const port = opts.port ?? (process.env.EDEN_MEMORY_PORT ? Number(process.env.EDEN_MEMORY_PORT) : 8787);
  const server = Bun.serve({
    port: Number.isFinite(port) && port > 0 ? port : 8787,
    async fetch(req) {
      try {
        const u = new URL(req.url);
        const p = u.pathname;
        if (req.method === "POST") {
          const b = (await req.json()) as { text?: string; kind?: string; tags?: string[]; id?: string; agent?: string; messages?: unknown[]; q?: string; k?: number };
          if (p === "/observe") return Response.json(memory.observe(b.messages || []));
          if (p === "/remember") return Response.json(memory.remember(String(b.text || ""), b));
          if (p === "/forget") return Response.json({ ok: memory.forget(String(b.id || b.text || "")) });
          if (p === "/inject") return Response.json({ messages: memory.inject(b.messages || []) });
          if (p === "/query") return Response.json(memory.query(String(b.q || ""), Number(b.k) || 5));
        }
        if (req.method === "GET" && p === "/health") return Response.json({ ok: true });
        if (req.method === "GET" && p === "/query") return Response.json(memory.query(u.searchParams.get("q") || "", Number(u.searchParams.get("k")) || 5));
        if (req.method === "GET" && p === "/memories") return Response.json(memory.memories());
        return new Response("eden memory\n");
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 400 });
      }
    },
  });
  return { url: String(server.url), stop: () => { memory.close(); server.stop(); }, memory };
}
