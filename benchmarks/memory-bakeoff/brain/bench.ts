/**
 * Benchmark brain POCs + HCM vs Eden / BM25 / lastk on LoCoMo retrieve@5 and @20.
 *
 *   bun benchmarks/memory-bakeoff/brain/bench.ts
 *
 * Optional answerer (weak local proxy for judge path):
 *   EDEN_BRAIN_ANSWER=1 bun benchmarks/memory-bakeoff/brain/bench.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../../src/index";
import { BrainMemory } from "../../../src/brain-memory"; // not-product
import {
  K5,
  K20,
  type MemSys,
  type Sample,
  type Turn,
  bm25,
  formatTurn,
  goldHit,
  loadLocomo,
  locomoTurns,
  toks,
} from "./shared";
import { AsaSys, ClsSys, HcmSys, SalienceSys, SchemaSys, TcmSys } from "./systems";

const MAX_CONV = Number(process.env.EDEN_BRAIN_CONV || "10");
const DO_ANSWER = process.env.EDEN_BRAIN_ANSWER === "1";
const OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.EDEN_BRAIN_MODEL || "llama3.2:1b";

class EdenBaseline implements MemSys {
  id = "eden";
  dir: string;
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "eden-base-"));
  }
  ingest(turns: Turn[]) {
    const mem = openMemory({ dir: this.dir });
    for (const t of turns) mem.observe([{ role: "user", content: `${t.speaker}: ${t.text}` }]);
    mem.close();
  }
  retrieve(q: string, k = 5) {
    const mem = openMemory({ dir: this.dir });
    const out = mem.notesFor(q, k).map((m) => m.text);
    mem.close();
    return out;
  }
  stored() {
    const mem = openMemory({ dir: this.dir });
    const out = mem.memories().map((m) => m.text);
    mem.close();
    return out;
  }
}

class Bm25All implements MemSys {
  id = "bm25-all";
  docs: string[] = [];
  ingest(turns: Turn[]) {
    this.docs = turns.map(formatTurn);
  }
  retrieve(q: string, k = 5) {
    return bm25(q, this.docs, k);
  }
  stored() {
    return this.docs.slice();
  }
}

class LastK implements MemSys {
  id = "lastk";
  buf: string[] = [];
  ingest(turns: Turn[]) {
    this.buf = turns.map(formatTurn).slice(-8);
  }
  retrieve(_q: string, k = 5) {
    return this.buf.slice(-k);
  }
  stored() {
    return this.buf.slice();
  }
}

class BrainProduct implements MemSys {
  id = "brain-product";
  mem = new BrainMemory();
  ingest(turns: Turn[]) {
    this.mem = new BrainMemory();
    this.mem.ingestTurns(turns);
  }
  retrieve(q: string, k = 5) {
    return this.mem.retrieve(q, k);
  }
  stored() {
    return this.mem.stored();
  }
}

async function ollamaAnswer(question: string, notes: string[]): Promise<string> {
  const prompt = `Answer the question using ONLY the memories. Be concise (short phrase or date).\n\nMemories:\n${notes.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\nQuestion: ${question}\nAnswer:`;
  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0, num_predict: 48 },
      }),
    });
    if (!res.ok) return "";
    const j = (await res.json()) as { response?: string };
    return String(j.response || "").trim();
  } catch {
    return "";
  }
}

function answerHit(got: string, answer: string): boolean {
  return goldHit(got, answer) || goldHit(answer, got);
}

type Score = {
  id: string;
  rec5: number;
  rec20: number;
  n: number;
  byCat5: Record<number, { ok: number; n: number }>;
  answerOk?: number;
  answerN?: number;
  ingestMs: number;
  queryMs: number;
};

function freshSystems(): MemSys[] {
  return [
    new EdenBaseline(),
    new Bm25All(),
    new LastK(),
    new AsaSys(),
    new TcmSys(),
    new ClsSys(),
    new SchemaSys(),
    new SalienceSys(),
    new HcmSys(),
    new BrainProduct(),
  ];
}

async function runSample(sample: Sample, systems: MemSys[]): Promise<void> {
  const turns = locomoTurns(sample.conversation);
  for (const sys of systems) sys.ingest(turns);
}

async function main() {
  const data = (await loadLocomo()).slice(0, MAX_CONV);
  const scores = new Map<string, Score>();
  const boot = freshSystems();
  for (const s of boot) {
    scores.set(s.id, {
      id: s.id,
      rec5: 0,
      rec20: 0,
      n: 0,
      byCat5: { 1: { ok: 0, n: 0 }, 2: { ok: 0, n: 0 }, 3: { ok: 0, n: 0 }, 4: { ok: 0, n: 0 } },
      answerOk: DO_ANSWER ? 0 : undefined,
      answerN: DO_ANSWER ? 0 : undefined,
      ingestMs: 0,
      queryMs: 0,
    });
  }

  for (const sample of data) {
    const systems = freshSystems();
    const turns = locomoTurns(sample.conversation);
    for (const sys of systems) {
      const t0 = performance.now();
      sys.ingest(turns);
      scores.get(sys.id)!.ingestMs += performance.now() - t0;
    }
    for (const qa of sample.qa) {
      if (qa.category === 5 || !qa.question || qa.answer == null) continue;
      for (const sys of systems) {
        const sc = scores.get(sys.id)!;
        sc.n++;
        const cat = sc.byCat5[qa.category] || (sc.byCat5[qa.category] = { ok: 0, n: 0 });
        cat.n++;
        const t1 = performance.now();
        const top5 = sys.retrieve(qa.question, K5);
        const top20 = sys.retrieve(qa.question, K20);
        sc.queryMs += performance.now() - t1;
        if (goldHit(top5.join("\n"), String(qa.answer))) {
          sc.rec5++;
          cat.ok++;
        }
        if (goldHit(top20.join("\n"), String(qa.answer))) sc.rec20++;
        if (DO_ANSWER) {
          sc.answerN!++;
          const ans = await ollamaAnswer(qa.question, top20.slice(0, 12));
          if (answerHit(ans, String(qa.answer))) sc.answerOk!++;
        }
      }
    }
  }

  const rows = [...scores.values()].map((s) => ({
    id: s.id,
    rec5: s.rec5,
    rec5_pct: +((100 * s.rec5) / s.n).toFixed(1),
    rec20: s.rec20,
    rec20_pct: +((100 * s.rec20) / s.n).toFixed(1),
    n: s.n,
    cat2_pct: s.byCat5[2] ? +((100 * s.byCat5[2].ok) / s.byCat5[2].n).toFixed(1) : 0,
    cat4_pct: s.byCat5[4] ? +((100 * s.byCat5[4].ok) / s.byCat5[4].n).toFixed(1) : 0,
    answer_pct: DO_ANSWER && s.answerN ? +((100 * s.answerOk!) / s.answerN!).toFixed(1) : null,
    ingest_ms: Math.round(s.ingestMs),
    query_ms_avg: +(s.queryMs / Math.max(1, s.n)).toFixed(2),
  }));
  rows.sort((a, b) => b.rec5_pct - a.rec5_pct);

  const out = {
    when: new Date().toISOString(),
    protocol: {
      metric: "LoCoMo cats 1-4 retrieve hit@5 and hit@20 (gold in notes)",
      answerer: DO_ANSWER ? `ollama:${OLLAMA_MODEL}` : "off",
      convs: MAX_CONV,
      note: "92% vendor scores use answerer+judge; rec20 is a closer evidence ceiling for that path",
    },
    rows,
  };
  const path = join(process.cwd(), "benchmarks/memory-bakeoff/brain/last-run.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.error("\nLeaderboard retrieve@5:");
  for (const r of rows) {
    console.error(
      `${r.id.padEnd(14)}  @5 ${String(r.rec5_pct).padStart(5)}%  @20 ${String(r.rec20_pct).padStart(5)}% ` +
        ` cat2 ${String(r.cat2_pct).padStart(5)}%  cat4 ${String(r.cat4_pct).padStart(5)}%` +
        (r.answer_pct != null ? `  ans ${r.answer_pct}%` : ""),
    );
  }
  console.error(`\nwrote ${path}`);
}

await main();
