/**
 * coding-agent bench: drives AgentMemory exactly the way the Claude Code hook does
 * (packages/cli/src/memory-hook.ts): after every assistant turn, observe() the last 40
 * user/assistant messages; at the start of a later session, notesFor(userPrompt, 6).
 *
 * Prints (lower is better unless noted):
 *   metric:   total probe misses across 5 worlds × 4 families (gold not in top-6 notes)
 *   junk:     stale value outranks fresh on updated facts + forbidden values surfaced on negatives
 *   ms:       min-of-3 wall time of the full workload (ingest sliding windows + all queries), /10
 *   chars:    mean chars injected per query (context budget)
 *   fam_*:    per-family misses / n (info)
 *   brain_miss: same probes via BrainMemory.retrieve (CLS lane, info only)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "../../src/index";
import { BrainMemory } from "../../src/brain-memory";
import { makeWorlds, type Msg, type Probe, type World } from "./coding-worlds";

const K = 6;
const WINDOW = 40;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9./_-]+/g, " ").replace(/\s+/g, " ").trim();
const has = (hay: string, needle: string) => hay.includes(norm(needle));

type Res = { miss: number; junk: number; chars: number; n: number; fam: Record<string, [number, number]> };

function judge(probe: Probe, notes: string[], res: Res) {
  const texts = notes.map(norm);
  const hay = texts.join(" \n ");
  res.chars += notes.reduce((a, t) => a + t.length, 0);
  res.n++;
  const f = (res.fam[probe.family] ||= [0, 0]);
  if (probe.negative) {
    f[1]++;
    if ((probe.forbidden || []).some((v) => has(hay, v))) res.junk++;
    return;
  }
  f[1]++;
  const goldRank = texts.findIndex((t) => probe.gold.some((g) => has(t, g)));
  if (goldRank < 0) { res.miss++; f[0]++; }
  if (probe.stale?.length) {
    const staleRank = texts.findIndex((t) => probe.stale!.some((v) => has(t, v)));
    if (staleRank >= 0 && (goldRank < 0 || staleRank < goldRank)) res.junk++;
  }
}

function runWorld(w: World, res: Res) {
  const dir = mkdtempSync(join(tmpdir(), "eden-coding-"));
  const mem = openMemory({ dir, agent: "claude-code", project: w.name });
  const transcript: Msg[] = [];
  for (const s of w.sessions) {
    for (const m of s.msgs) {
      transcript.push(m);
      if (m.role === "assistant") mem.observe(transcript.slice(-WINDOW));
    }
    // session boundary: hook observes again on SessionEnd
    mem.observe(transcript.slice(-WINDOW));
  }
  for (const p of w.probes) {
    const notes = mem.notesFor(p.q, K).map((r) => r.text);
    judge(p, notes, res);
  }
  mem.close();
  rmSync(dir, { recursive: true, force: true });
}

function runBrain(w: World): number {
  const brain = new BrainMemory();
  const turns: { text: string; speaker: string; session: number; at: number }[] = [];
  let at = 0;
  w.sessions.forEach((s, si) => { for (const m of s.msgs) turns.push({ text: m.content, speaker: m.role, session: si, at: at++ }); });
  brain.ingestTurns(turns);
  let miss = 0;
  for (const p of w.probes) {
    if (p.negative) continue;
    const hay = brain.retrieve(p.q, K).map(norm).join(" \n ");
    if (!p.gold.some((g) => has(hay, g))) miss++;
  }
  brain.close();
  return miss;
}

function main() {
  const worlds = makeWorlds(5);
  let best = Infinity;
  let res: Res = { miss: 0, junk: 0, chars: 0, n: 0, fam: {} };
  for (let rep = 0; rep < 3; rep++) {
    const r: Res = { miss: 0, junk: 0, chars: 0, n: 0, fam: {} };
    const t0 = performance.now();
    for (const w of worlds) runWorld(w, r);
    best = Math.min(best, performance.now() - t0);
    res = r;
  }
  let brainMiss = 0;
  for (const w of worlds) brainMiss += runBrain(w);
  const msgs = worlds.reduce((a, w) => a + w.sessions.reduce((b, s) => b + s.msgs.length, 0), 0);
  console.log(`metric: ${res.miss}`);
  console.log(`junk: ${res.junk}`);
  console.log(`ms: ${Math.round(best / 10)}`);
  console.log(`chars: ${Math.round(res.chars / Math.max(1, res.n))}`);
  for (const [fam, [m, n]] of Object.entries(res.fam).sort()) console.log(`fam_${fam}: ${m}/${n}`);
  console.log(`brain_miss: ${brainMiss}`);
  console.log(`info: ${worlds.length} worlds, ${msgs} messages, ${res.n} probes, best wall ${Math.round(best)}ms`);
}
main();
