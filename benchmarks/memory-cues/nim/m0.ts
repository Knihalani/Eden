// M0: Eden's current Submit retrieval, imported from the repo (src/index.ts), one cascade store per cue scope.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const EDEN = "/Users/kaiavnihalani/Downloads/Eden";
process.env.EDEN_MEMORY = "on"; process.env.EDEN_MEMORY_LOG = "0";
const { openMemory, isNoopCue, attachPlaceCues, packNotes, PACKET_BYTE_CAP, PACKET_BULLET_MAX, memoryRetrieveCap } = await import(`${EDEN}/src/index.ts`);
const { hookLane } = await import(`${EDEN}/src/memory-sota.ts`);
const mems: any[] = await Bun.file("fixture/memories.json").json();
const cues: any[] = await Bun.file(process.env.CUES ?? "fixture/cues.json").json();
const live = mems.filter((m) => !m.superseded_by);
const scopes = [...new Set(cues.map((c) => c.scope))];
const root = mkdtempSync("/private/tmp/claude-501/-Users-kaiavnihalani-Downloads-Eden/af5ec543-ea72-43a6-b1e5-cbb5004cc31b/scratchpad/nim/tmp-m0-");
const stores: Record<string, any> = {}, textToId: Record<string, Map<string, string>> = {};
const t0 = performance.now();
for (const s of scopes) {
  process.env.EDEN_MEMORY = "on";
  const mem = openMemory({ dir: join(root, s.replace(/\//g, "_") || "root") }); const map = new Map<string, string>();
  mem.quiet(() => { for (const m of live.filter((m) => m.scope === "" || m.scope === s)) { const r = mem.remember(m.text, { kind: m.kind, id: m.id }); map.set(r.id, m.id); } });
  stores[s] = mem; textToId[s] = map;
}
const buildMs = performance.now() - t0;
process.env.EDEN_MEMORY = "readonly";
function run(mem: any, cue: string): string[] {
  if (!cue || isNoopCue(cue) || hookLane(cue) === "none") return [];
  const notes = mem.notesFor(cue);
  const packed = packNotes(notes, PACKET_BYTE_CAP, Math.min(PACKET_BULLET_MAX, memoryRetrieveCap()));
  return packed.map((n: any) => n.id);
}
const out: Record<string, any> = {}; const lat: number[] = [];
for (const c of cues) {
  const mem = stores[c.scope];
  const t = performance.now();
  const plain = run(mem, c.cue);
  lat.push(performance.now() - t);
  const ctx = run(mem, attachPlaceCues(c.cue, c.last_paths));
  const ctx2 = run(mem, attachPlaceCues([c.cue, c.prev_turn].filter(Boolean).join("\n\n"), c.last_paths));
  out[c.id] = { M0: plain, M0_paths: ctx, M0_ctx: ctx2 };
}
mkdirSync("out", { recursive: true }); writeFileSync(`out/m0${process.env.OUT_SFX ?? ""}.json`, JSON.stringify(out));
lat.sort((a, b) => a - b);
console.log(JSON.stringify({ buildMs, warm_p50_ms: lat[Math.floor(lat.length * 0.5)], warm_p95_ms: lat[Math.floor(lat.length * 0.95)], n: lat.length, sample: out["q000"], sample2: out["q005"] }));
