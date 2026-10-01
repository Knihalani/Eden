/**
 * Memory bakeoff: Eden vs architectural stand-ins of cutting-edge agent memory.
 *
 * Retrieval hit = gold string (or all content tokens) appears in top-k notes.
 * Passive inject = after observe/ingest, inject(asked) contains gold.
 * No LLM judge. LoCoMo cats 1–4 (industry convention skips adversarial cat 5).
 *
 * Systems:
 *   eden          — product (heuristic extract + token-overlap retrieve + inject)
 *   lastk         — working-memory / Letta-core analogue
 *   storeall-bm25 — RAG / Mem0-without-LLM-extract analogue
 *   llm-extract   — Mem0-class fact extract via OpenRouter, then overlap retrieve
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory, MEMORY_MARK, type AgentMemory } from "../../src/index";
import { injectFromText, injectNote } from "../../packages/know/src/inject";
import { knowQuery } from "../../packages/know/src/query";
import { CAPTURE, DISTRACTORS, JUNK, KNOW_INJECT, type Want } from "./cases";

const K = 5;
const LAST_K = 8;
const ROOT = mkdtempSync(join(tmpdir(), "eden-mem-bake-"));
const OPENROUTER = process.env.OPENROUTER_API_KEY || "";
const LLM_MODEL = process.env.EDEN_BAKEOFF_MODEL || "openai/gpt-4o-mini";
const LOCOMO_PATH = process.env.LOCOMO_PATH || "/tmp/eden-mem-bakeoff/locomo10.json";
const LOCOMO_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";
const SKIP_LLM =
  process.env.EDEN_BAKEOFF_SKIP_LLM === "1" || !OPENROUTER || OPENROUTER.length < 40 || /^your_/i.test(OPENROUTER);
const LOCOMO_MAX_CONV = Number(process.env.EDEN_BAKEOFF_LOCOMO_CONV || "10");

type Sys = {
  id: string;
  ingest(texts: string[]): Promise<void> | void;
  ingestRaw?(texts: string[]): void;
  retrieve(q: string, k?: number): string[];
  injectAsked(asked: string): Promise<string> | string;
  stored(): string[];
  close(): void;
};

const STOP = new Set(
  "the of is a an on to and in for this that with from into about these then still has out how what why was are you your its our not or no".split(
    " ",
  ),
);

function toks(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? []).filter(
    (w) => w.length >= 2 && !STOP.has(w),
  );
}

function blob(parts: string[]): string {
  return parts.join("\n");
}

function hitsWant(got: string, want: Want): boolean {
  return Array.isArray(want) ? want.every((re) => re.test(got)) : want.test(got);
}

function goldHit(retrieved: string, answer: string): boolean {
  const a = String(answer || "")
    .toLowerCase()
    .trim();
  const r = retrieved.toLowerCase();
  if (!a) return false;
  if (r.includes(a)) return true;
  if (a.length <= 8) return false;
  const t = toks(a);
  return t.length > 0 && t.every((w) => r.includes(w));
}

function overlapScore(q: string, doc: string): number {
  const hay = new Set(toks(doc));
  return toks(q).reduce((n, w) => n + +hay.has(w), 0);
}

function bm25(query: string, docs: string[], k: number): string[] {
  const N = docs.length || 1;
  const dl = docs.map((d) => Math.max(1, toks(d).length));
  const avgdl = dl.reduce((a, b) => a + b, 0) / N;
  const df = new Map<string, number>();
  const tfs: Map<string, number>[] = docs.map((d) => {
    const m = new Map<string, number>();
    for (const w of toks(d)) m.set(w, (m.get(w) || 0) + 1);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
    return m;
  });
  const q = toks(query);
  const k1 = 1.5,
    b = 0.75;
  const scored = docs.map((d, i) => {
    let s = 0;
    const tf = tfs[i]!;
    for (const w of q) {
      const n = tf.get(w) || 0;
      if (!n) continue;
      const idf = Math.log((N - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5) + 1);
      s += (idf * (n * (k1 + 1))) / (n + k1 * (1 - b + b * (dl[i]! / avgdl)));
    }
    return { d, s };
  });
  return scored
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.d);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!\n])\s+/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter((s) => s.length >= 8 && s.length <= 400);
}

function injectedNotes(mem: AgentMemory, asked: string): string {
  const orig = [{ role: "user" as const, content: asked }];
  const next = mem.inject(orig);
  return next
    .filter((m) => m && typeof m === "object" && (m as { role?: string }).role === "system")
    .map((m) => String((m as { content?: string }).content || ""))
    .join("\n");
}

class EdenSys implements Sys {
  id = "eden";
  mem: AgentMemory;
  constructor(dir: string) {
    this.mem = openMemory({ dir });
  }
  ingest(texts: string[]) {
    for (const t of texts) this.mem.observe([{ role: "user", content: t }]);
  }
  retrieve(q: string, k = K) {
    return this.mem.notesFor(q, k).map((m) => m.text);
  }
  injectAsked(asked: string) {
    return injectedNotes(this.mem, asked);
  }
  stored() {
    return this.mem.memories().map((m) => m.text);
  }
  close() {
    this.mem.close();
  }
}

class LastKSys implements Sys {
  id = "lastk";
  buf: string[] = [];
  ingest(texts: string[]) {
    this.buf.push(...texts);
    if (this.buf.length > LAST_K) this.buf = this.buf.slice(-LAST_K);
  }
  retrieve(_q: string, k = K) {
    return this.buf.slice(-k);
  }
  injectAsked(_asked: string) {
    return this.buf.join("\n");
  }
  stored() {
    return this.buf.slice();
  }
  close() {}
}

class Bm25Sys implements Sys {
  id = "storeall-bm25";
  docs: string[] = [];
  ingest(texts: string[]) {
    for (const t of texts) this.docs.push(...(sentences(t).length ? sentences(t) : t.trim() ? [t.trim()] : []));
  }
  retrieve(q: string, k = K) {
    return bm25(q, this.docs, k);
  }
  injectAsked(asked: string) {
    return this.retrieve(asked).join("\n");
  }
  stored() {
    return this.docs.slice();
  }
  close() {}
}

class OverlapStoreSys implements Sys {
  id = "storeall-overlap";
  docs: string[] = [];
  ingest(texts: string[]) {
    for (const t of texts) this.docs.push(...(sentences(t).length ? sentences(t) : t.trim() ? [t.trim()] : []));
  }
  retrieve(q: string, k = K) {
    return this.docs
      .map((d) => ({ d, s: overlapScore(q, d) }))
      .filter((x) => x.s)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.d);
  }
  injectAsked(asked: string) {
    return this.retrieve(asked).join("\n");
  }
  stored() {
    return this.docs.slice();
  }
  close() {}
}

async function llmFacts(text: string): Promise<string[]> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENROUTER}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            'Extract durable facts from the user message. Return JSON {"facts":["..."]}. Skip chit-chat, questions, code, URLs, and secrets. Empty facts if nothing durable.',
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = json.choices?.[0]?.message?.content || "";
  const m = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m?.[0] || raw) as { facts?: unknown };
  return Array.isArray(parsed.facts) ? parsed.facts.map((x) => String(x).trim()).filter((s) => s.length >= 8) : [];
}

class LlmExtractSys implements Sys {
  id = "llm-extract";
  docs: string[] = [];
  ingestRaw(texts: string[]) {
    this.docs.push(...texts.map((t) => t.trim()).filter(Boolean));
  }
  async ingest(texts: string[]) {
    for (const t of texts) {
      try {
        const facts = await llmFacts(t);
        this.docs.push(...facts);
      } catch {
        /* leave empty for this turn */
      }
    }
  }
  retrieve(q: string, k = K) {
    return this.docs
      .map((d) => ({ d, s: overlapScore(q, d) }))
      .filter((x) => x.s)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.d);
  }
  injectAsked(asked: string) {
    return this.retrieve(asked).join("\n");
  }
  stored() {
    return this.docs.slice();
  }
  close() {}
}

function openSys(id: string, dir: string): Sys {
  if (id === "eden") return new EdenSys(dir);
  if (id === "lastk") return new LastKSys();
  if (id === "storeall-bm25") return new Bm25Sys();
  if (id === "storeall-overlap") return new OverlapStoreSys();
  if (id === "llm-extract") return new LlmExtractSys();
  throw new Error(id);
}

type Row = { id: string; family: string; hit: boolean };

async function runPassive(ids: string[]) {
  const out: Record<
    string,
    {
      capture: number;
      captureN: number;
      byFamily: Record<string, { ok: number; n: number }>;
      junkFp: number;
      junkN: number;
      storedJunk: number;
      ingestMs: number;
      retrieveMs: number;
      misses: string[];
      rows: Row[];
    }
  > = {};

  for (const id of ids) {
    const byFamily: Record<string, { ok: number; n: number }> = {};
    const rows: Row[] = [];
    const misses: string[] = [];
    let capture = 0,
      ingestMs = 0,
      retrieveMs = 0,
      junkFp = 0,
      storedJunk = 0;
    for (const row of CAPTURE) {
      const dir = join(ROOT, id, row.id);
      mkdirSync(dir, { recursive: true });
      const sys = openSys(id, dir);
      const t0 = performance.now();
      await sys.ingest(row.stated);
      if (sys.ingestRaw) sys.ingestRaw(DISTRACTORS);
      else await sys.ingest(DISTRACTORS);
      ingestMs += performance.now() - t0;
      const t1 = performance.now();
      const got = await sys.injectAsked(row.asked);
      retrieveMs += performance.now() - t1;
      const ok = hitsWant(got, row.want);
      byFamily[row.family] ??= { ok: 0, n: 0 };
      byFamily[row.family]!.n++;
      if (ok) {
        capture++;
        byFamily[row.family]!.ok++;
      } else misses.push(row.id);
      rows.push({ id: row.id, family: row.family, hit: ok });
      sys.close();
    }
    for (const j of JUNK) {
      const dir = join(ROOT, id, "junk-" + j.id);
      mkdirSync(dir, { recursive: true });
      const sys = openSys(id, dir);
      await sys.ingest([j.stated]);
      const stored = blob(sys.stored());
      if (
        stored.toLowerCase().includes(j.stated.slice(0, 12).toLowerCase()) ||
        (j.stated.length >= 8 && stored.toLowerCase().includes(j.stated.toLowerCase()))
      )
        storedJunk++;
      const got = await sys.injectAsked("What time should I ping Kai about the release?");
      if (
        got &&
        (j.stated.length < 8
          ? got.toLowerCase().includes(j.stated.toLowerCase())
          : got.toLowerCase().includes(j.stated.slice(0, 18).toLowerCase()))
      )
        junkFp++;
      sys.close();
    }
    out[id] = {
      capture,
      captureN: CAPTURE.length,
      byFamily,
      junkFp,
      junkN: JUNK.length,
      storedJunk,
      ingestMs: ingestMs / CAPTURE.length,
      retrieveMs: retrieveMs / CAPTURE.length,
      misses,
      rows,
    };
  }
  return out;
}

function locomoTurns(conv: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(conv)) {
    if (!k.startsWith("session_") || k.includes("date") || !Array.isArray(v)) continue;
    for (const turn of v as { text?: string; speaker?: string }[]) {
      const t = String(turn?.text || "").trim();
      if (t) out.push(`${turn.speaker || "speaker"}: ${t}`);
    }
  }
  return out;
}

async function ensureLocomo(): Promise<unknown[] | null> {
  if (!existsSync(LOCOMO_PATH)) {
    mkdirSync(join(LOCOMO_PATH, ".."), { recursive: true });
    const res = await fetch(LOCOMO_URL);
    if (!res.ok) return null;
    writeFileSync(LOCOMO_PATH, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(readFileSync(LOCOMO_PATH, "utf8")) as unknown[];
}

async function runLocomo(ids: string[]) {
  const data = await ensureLocomo();
  if (!data) return { error: "locomo download failed" as const };
  const convs = data.slice(0, LOCOMO_MAX_CONV) as {
    sample_id?: string;
    conversation: Record<string, unknown>;
    qa: { question: string; answer: string; category: number }[];
  }[];
  const out: Record<
    string,
    { rec5: number; n: number; byCat: Record<string, { ok: number; n: number }>; ingestMs: number; queryMs: number }
  > = {};
  for (const id of ids) {
    let rec5 = 0,
      n = 0,
      ingestMs = 0,
      queryMs = 0;
    const byCat: Record<string, { ok: number; n: number }> = {};
    for (const sample of convs) {
      const dir = join(ROOT, "locomo", id, String(sample.sample_id || Math.random()));
      mkdirSync(dir, { recursive: true });
      const sys = openSys(id, dir);
      const turns = locomoTurns(sample.conversation);
      const t0 = performance.now();
      await sys.ingest(turns);
      ingestMs += performance.now() - t0;
      for (const qa of sample.qa) {
        if (qa.category === 5) continue;
        n++;
        const cat = String(qa.category);
        byCat[cat] ??= { ok: 0, n: 0 };
        byCat[cat]!.n++;
        const t1 = performance.now();
        const got = blob(sys.retrieve(qa.question, K));
        queryMs += performance.now() - t1;
        if (goldHit(got, qa.answer)) {
          rec5++;
          byCat[cat]!.ok++;
        }
      }
      sys.close();
    }
    out[id] = { rec5, n, byCat, ingestMs, queryMs: n ? queryMs / n : 0 };
  }
  return out;
}

function knowInject() {
  const rows = KNOW_INJECT.map((row) => {
    const card = injectFromText(row.asked);
    const got = card ? injectNote(card) : "";
    const ok = row.want === "silent" ? !got.trim() : hitsWant(got, row.want);
    return { id: row.id, hit: ok, got: got.slice(0, 160) };
  });
  return { ok: rows.filter((r) => r.hit).length, n: rows.length, rows };
}

const KNOW_QUERY: { id: string; q: string; want: RegExp }[] = [
  { id: "kq-kenya", q: "capital of Kenya", want: /Nairobi/i },
  { id: "kq-kenya-s", q: "Kenya's capital", want: /Nairobi/i },
  { id: "kq-rfc", q: "RFC 9110", want: /HTTP Semantics/i },
  { id: "kq-jq", q: "what is jq used for", want: /JSON/i },
  { id: "kq-rg", q: "ripgrep is used for", want: /search/i },
];

function knowRetrieve() {
  const rows = KNOW_QUERY.map((row) => {
    const card = knowQuery(row.q);
    const got = card && "fact" in card ? String(card.fact) : "";
    return { id: row.id, hit: row.want.test(got), got: got.slice(0, 160) };
  });
  return { ok: rows.filter((r) => r.hit).length, n: rows.length, rows };
}

const LOCAL_IDS = ["eden", "lastk", "storeall-overlap", "storeall-bm25"];
const PASSIVE_IDS = SKIP_LLM ? LOCAL_IDS : [...LOCAL_IDS, "llm-extract"];
const LOCOMO_IDS = LOCAL_IDS;

const tAll = performance.now();
const passive = await runPassive(PASSIVE_IDS);
const locomo = await runLocomo(LOCOMO_IDS);
const know = knowInject();
const knowQ = knowRetrieve();
const report = {
  when: new Date().toISOString(),
  protocol: {
    k: K,
    lastk: LAST_K,
    locomoCats: "1-4 (skip adversarial 5)",
    locomoMetric: "retrieval hit@5, no LLM judge",
    llm: SKIP_LLM ? "skipped (no live vendor key)" : LLM_MODEL,
    note: "Vendor LoCoMo/LongMemEval scores use an answerer+judge LLM. This run measures whether gold is in retrieved notes.",
  },
  verdictHint:
    "Eden is a local heuristic memory for engineering chat + a packed knowledge graph. It is not a Mem0/Zep/Letta replacement.",
  passive,
  locomo,
  knowInject: know,
  knowQuery: knowQ,
  elapsedMs: performance.now() - tAll,
};

const outDir = join(import.meta.dir);
writeFileSync(join(outDir, "last-run.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
rmSync(ROOT, { recursive: true, force: true });
