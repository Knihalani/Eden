/**
 * One-shot inject/persist baseline. Not a CI bench (not named *.test.ts).
 *
 *   bun benchmarks/memoryagentbench/baseline-measure.ts
 *
 * Product path only: openMemory + inject. Know disabled so the clock is AgentMemory.
 * Prints this run as M34 against the dated M6.4 snapshot (constants below),
 * then an M49.2 2k-store inject against the dated M34 5-row snapshot.
 * The M1.4 / M6.4 / M34 tables in BASELINE.md stay historical — this script does not
 * relabel the live 5-row run as M6.4 or M34. k stays product default (EDEN_MEMORY_CAP unset).
 * Store cap stays the product default (EDEN_MEMORY_STORE_CAP unset → 2000).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPERIENCE_SLICE_TOKEN_CAP,
  memoryInjectSwallows,
  openMemory,
  MEMORY_WAL_COMPACT_LINES,
  MEMORY_WAL_SUFFIX,
  PACKET_CHAT_K_DEFAULT,
  PACKET_CHAT_K_MAX,
  PACKET_CHAT_K_MIN,
  PROCEDURE_TOKEN_CAP,
} from "../../src/index";

const N = 80;
/** Dated M1.4 snapshot from BASELINE.md (2026-09-16). Not this run. */
const M14 = {
  p50: 0.088,
  p95: 0.233,
  bytes: 765,
  jsonlN: 4,
  happy: 0,
  forced: 1,
  min: 0.059,
  max: 5.79,
};
/** Dated M6.4 snapshot from BASELINE.md (2026-09-17). Comparison target for M34. */
const M64 = { p50: 0.048, p95: 0.133, bytes: 1009, jsonlN: 5, happy: 0, forced: 1, min: 0.03, max: 5.575 };
/** Dated M34 snapshot from BASELINE.md (2026-09-22). 5-row fixture. Comparison target for M49.2. */
const M34 = { p50: 0.59, p95: 1.016, jsonlN: 5 };
/** Honest store size. Matches `EDEN_MEMORY_STORE_CAP` default. Not raised. */
const STORE_2K = 2000;
const N_2K = 80;
const FIXTURE = [
  { role: "user", content: "Kai's timezone is Pacific." },
  { role: "assistant", content: "Noted. The staging endpoint is api.internal." },
  { role: "user", content: "Postgres is the session store." },
  { role: "assistant", content: "The deploy region is us-east-1." },
  { role: "user", content: "What timezone is Kai in?" },
];
const QUERY = "What timezone is Kai in?";

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i),
    hi = Math.ceil(i);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

function ms(n: number): string {
  return n.toFixed(3);
}

function roundMs(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** WIN if strictly under the snapshot, parity if equal at 0.001 ms, else slower. */
function vsLatency(cur: number, base: number): "WIN" | "parity" | "slower" {
  const c = roundMs(cur);
  const b = roundMs(base);
  if (c < b) return "WIN";
  if (c === b) return "parity";
  return "slower";
}

function overallLatency(
  p50v: "WIN" | "parity" | "slower",
  p95v: "WIN" | "parity" | "slower",
): "WIN" | "parity" | "slower" {
  if (p50v === "slower" || p95v === "slower") return "slower";
  if (p50v === "WIN" || p95v === "WIN") return "WIN";
  return "parity";
}

function deltaMs(n: number): string {
  const r = roundMs(n);
  if (r === 0) return "0";
  return `${r > 0 ? "+" : ""}${r.toFixed(3)}`;
}

function deltaInt(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : ""}${n}`;
}

function diskSnapshot(
  dir: string,
  jsonl: string,
): {
  jsonlBytes: number;
  jsonlN: number;
  wals: { name: string; bytes: number }[];
  walBytes: number;
  walN: number;
  query: boolean;
} {
  const jsonlBytes = existsSync(jsonl) ? statSync(jsonl).size : 0;
  const raw = existsSync(jsonl) ? readFileSync(jsonl, "utf8") : "";
  const lines = raw.split("\n").filter((l) => l.trim());
  const wals = walBeside(dir);
  let walN = 0;
  let query = lines.some((l) => l.includes(QUERY));
  for (const w of wals) {
    try {
      const text = readFileSync(join(dir, w.name), "utf8");
      walN += text.split("\n").filter((l) => l.trim()).length;
      if (text.includes(QUERY)) query = true;
    } catch {}
  }
  return {
    jsonlBytes,
    jsonlN: lines.length,
    wals,
    walBytes: wals.reduce((s, w) => s + w.bytes, 0),
    walN,
    query,
  };
}

function walBeside(dir: string): { name: string; bytes: number }[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; bytes: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".wal")) continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile()) out.push({ name, bytes: st.size });
    } catch {}
  }
  return out;
}

process.env.EDEN_KNOW = "0";
delete process.env.EDEN_MEMORY_CAP;
memoryInjectSwallows.n = 0;

const dir = mkdtempSync(join(tmpdir(), "eden-m34-base-"));
const jsonl = join(dir, "memories.jsonl");
try {
  const mem = openMemory({ dir });
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    mem.inject(FIXTURE);
    times.push(performance.now() - t0);
  }
  const pre = diskSnapshot(dir, jsonl);
  mem.close();
  const post = diskSnapshot(dir, jsonl);

  const happySwallows = memoryInjectSwallows.n;
  const jsonlBytes = post.jsonlBytes;
  const jsonlN = post.jsonlN;
  const queryStored = post.query || pre.query;
  const wals = post.wals;
  const walBytes = post.walBytes;
  const persistScope =
    post.walBytes > 0
      ? `JSONL+WAL after close (${post.wals.map((w) => `${w.name}=${w.bytes}B`).join(", ")}; jsonl=${post.jsonlBytes}B; pre-close wal=${pre.walBytes}B/${pre.walN} lines)`
      : pre.walBytes > 0
        ? `JSONL-only after close() compact (WAL unlinked). Pre-close ${pre.wals.map((w) => w.name).join(",") || "wal"}=${pre.walBytes}B / ${pre.walN} lines; jsonl was ${pre.jsonlBytes}B / n=${pre.jsonlN}. Table bytes are post-close JSONL ${post.jsonlBytes}B.`
        : "JSONL-only (no .wal beside memories.jsonl before or after close)";
  const bytes = post.jsonlBytes + post.walBytes;

  const probeDir = mkdtempSync(join(tmpdir(), "eden-m34-probe-"));
  try {
    const probe = openMemory({ dir: probeDir });
    const list = [{ role: "user", content: "Kai's timezone is Pacific." }];
    const before = memoryInjectSwallows.n;
    probe.notesFor = (() => {
      throw new Error("m1.4 fail-open probe");
    }) as typeof probe.notesFor;
    const out = probe.inject(list);
    const forced = out === list && memoryInjectSwallows.n === before + 1 ? 1 : 0;
    probe.close();

    times.sort((a, b) => a - b);
    const p50 = pct(times, 50);
    const p95 = pct(times, 95);
    const bunVer = typeof Bun !== "undefined" ? Bun.version : (process.versions.bun ?? "?");
    const p50v = vsLatency(p50, M64.p50);
    const p95v = vsLatency(p95, M64.p95);
    const latency = overallLatency(p50v, p95v);
    const day = new Date().toISOString().slice(0, 10);
    const machine = `Darwin ${release()} ${process.arch} / bun ${bunVer}`;

    const value = [
      `| metric | value |`,
      `|---|---|`,
      `| inject p50 (ms) | ${ms(p50)} |`,
      `| inject p95 (ms) | ${ms(p95)} |`,
      `| persist bytes | ${bytes} |`,
      `| JSONL n | ${jsonlN} |`,
      `| swallows (happy path) | ${happySwallows} |`,
      `| swallows (forced throw) | ${forced} |`,
      `| min / max (ms) | ${ms(times[0]!)} / ${ms(times[times.length - 1]!)} |`,
    ].join("\n");

    const cmp = [
      `| metric | M6.4 | M34 | delta |`,
      `|---|---|---|---|`,
      `| inject p50 (ms) | ${ms(M64.p50)} | ${ms(p50)} | ${deltaMs(p50 - M64.p50)} |`,
      `| inject p95 (ms) | ${ms(M64.p95)} | ${ms(p95)} | ${deltaMs(p95 - M64.p95)} |`,
      `| persist bytes | ${M64.bytes} | ${bytes} | ${deltaInt(bytes - M64.bytes)} |`,
      `| JSONL n | ${M64.jsonlN} | ${jsonlN} | ${deltaInt(jsonlN - M64.jsonlN)} |`,
      `| swallows (happy path) | ${M64.happy} | ${happySwallows} | ${deltaInt(happySwallows - M64.happy)} |`,
      `| swallows (forced throw) | ${M64.forced} | ${forced} | ${deltaInt(forced - M64.forced)} |`,
      `| min / max (ms) | ${ms(M64.min)} / ${ms(M64.max)} | ${ms(times[0]!)} / ${ms(times[times.length - 1]!)} | ${deltaMs(times[0]! - M64.min)} / ${deltaMs(times[times.length - 1]! - M64.max)} |`,
    ].join("\n");

    console.log(`# AgentMemory inject baseline (M34 remeasure)`);
    console.log(`date: ${day}`);
    console.log(`machine: ${machine}`);
    console.log(`script: bun benchmarks/memoryagentbench/baseline-measure.ts`);
    console.log(`N: ${N}`);
    console.log(`k: default (EDEN_MEMORY_CAP unset → 6; chat band 6–10)`);
    console.log(`fixture: 4 durable turns + 1 query (FIXTURE); EDEN_KNOW=0`);
    console.log(`persist scope: ${persistScope}`);
    console.log(`jsonl bytes: ${jsonlBytes}`);
    console.log(`wal bytes: ${walBytes}`);
    console.log(`query turn stored: ${queryStored ? "yes" : "NO"} (JSONL n=${jsonlN}; M6.4 store-all n=${M64.jsonlN})`);
    console.log(
      `packet budget: M34.3 src/index.ts PACKET_CHAT_K_MIN=${PACKET_CHAT_K_MIN} PACKET_CHAT_K_MAX=${PACKET_CHAT_K_MAX} PACKET_CHAT_K_DEFAULT=${PACKET_CHAT_K_DEFAULT} (EDEN_MEMORY_CAP unset → ${PACKET_CHAT_K_DEFAULT}). PROCEDURE_TOKEN_CAP=${PROCEDURE_TOKEN_CAP}. EXPERIENCE_SLICE_TOKEN_CAP=${EXPERIENCE_SLICE_TOKEN_CAP} (re-export of src/experience-retrieve.ts).`,
    );
    console.log(
      `pre-close: jsonl ${pre.jsonlBytes}B n=${pre.jsonlN}; wal ${pre.walBytes}B n=${pre.walN}; query=${pre.query ? "yes" : "NO"}`,
    );
    console.log(
      `post-close: jsonl ${post.jsonlBytes}B n=${post.jsonlN}; wal ${post.walBytes}B n=${post.walN}; query=${post.query ? "yes" : "NO"}`,
    );
    console.log(
      `m34.1-3 at measure: WAL suffix ${MEMORY_WAL_SUFFIX}, compact at ${MEMORY_WAL_COMPACT_LINES} lines or close(); M34.3 packet constants present; retrieve score loop is relevant() in src/index.ts`,
    );
    console.log(`fail-open: catch → pass-through (forced probe ${forced === 1 ? "ok" : "FAIL"})`);
    console.log(
      `snapshots held: M1.4 p50 ${ms(M14.p50)} / p95 ${ms(M14.p95)}; M6.4 p50 ${ms(M64.p50)} / p95 ${ms(M64.p95)} (not overwritten by this run)`,
    );
    console.log();
    console.log(value);
    console.log();
    console.log(`## M34 remeasure vs M6.4`);
    console.log(`latency p50 vs M6.4: ${p50v}`);
    console.log(`latency p95 vs M6.4: ${p95v}`);
    console.log(`latency vs M6.4 p50/p95: ${latency}`);
    console.log();
    console.log(cmp);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

/** Distinct copula facts. Unique subjects so subjectKey does not collapse the store. */
function storeFact(i: number): string {
  const id = String(i).padStart(4, "0");
  return `Operator op${id} lives in city c${id}.`;
}

const CUE_2K = "Where does operator op0042 live?";

function measure2kStore(): void {
  delete process.env.EDEN_MEMORY_STORE_CAP;
  delete process.env.EDEN_MEMORY_CAP;
  process.env.EDEN_KNOW = "0";
  memoryInjectSwallows.n = 0;

  const dir2 = mkdtempSync(join(tmpdir(), "eden-m49-2k-"));
  const jsonl2 = join(dir2, "memories.jsonl");
  try {
    const seed = openMemory({ dir: dir2 });
    const seedT0 = performance.now();
    seed.observe(Array.from({ length: STORE_2K }, (_, i) => ({ role: "user", content: storeFact(i) })));
    seed.close();
    const seedMs = performance.now() - seedT0;
    const seeded = diskSnapshot(dir2, jsonl2);

    const mem = openMemory({ dir: dir2 });
    const times: number[] = [];
    const before = memoryInjectSwallows.n;
    for (let i = 0; i < N_2K; i++) {
      const t0 = performance.now();
      mem.inject([{ role: "user", content: CUE_2K }]);
      times.push(performance.now() - t0);
    }
    const happySwallows = memoryInjectSwallows.n - before;
    mem.close();
    const post = diskSnapshot(dir2, jsonl2);

    times.sort((a, b) => a - b);
    const p50 = pct(times, 50);
    const p95 = pct(times, 95);
    const bunVer = typeof Bun !== "undefined" ? Bun.version : (process.versions.bun ?? "?");
    const p50v = vsLatency(p50, M34.p50);
    const p95v = vsLatency(p95, M34.p95);
    const latency = overallLatency(p50v, p95v);
    const day = new Date().toISOString().slice(0, 10);
    const machine = `Darwin ${release()} ${process.arch} / bun ${bunVer}`;

    console.log();
    console.log(`# AgentMemory inject baseline (M49.2 2k-store)`);
    console.log(`date: ${day}`);
    console.log(`machine: ${machine}`);
    console.log(`script: bun benchmarks/memoryagentbench/baseline-measure.ts`);
    console.log(`N: ${N_2K} injects after the store exists (seed wall ${ms(seedMs)} ms is not in p50/p95)`);
    console.log(`k: default (EDEN_MEMORY_CAP unset → 6; chat band 6–10)`);
    console.log(
      `store: ${STORE_2K} distinct facts via openMemory.observe; EDEN_MEMORY_STORE_CAP unset (default 2000); EDEN_KNOW=0`,
    );
    console.log(`cue: ${CUE_2K}`);
    console.log(`seeded JSONL n: ${seeded.jsonlN} (${seeded.jsonlBytes} B)`);
    console.log(`post-inject JSONL n: ${post.jsonlN} (${post.jsonlBytes} B)`);
    console.log(`swallows during timed injects: ${happySwallows}`);
    console.log(`fail-open: catch → pass-through (5-row forced probe above; 2k happy swallows ${happySwallows})`);
    console.log(
      `compare: dated M34 5-row p50 ${ms(M34.p50)} / p95 ${ms(M34.p95)} (JSONL n=${M34.jsonlN}). This is not that fixture.`,
    );
    console.log(`latency p50 vs M34 5-row: ${p50v}`);
    console.log(`latency p95 vs M34 5-row: ${p95v}`);
    console.log(`latency vs M34 5-row p50/p95: ${latency}`);
    console.log();
    console.log(
      [
        `| metric | M34 (5-row) | M49.2 (2k-store) | delta |`,
        `|---|---|---|---|`,
        `| inject p50 (ms) | ${ms(M34.p50)} | ${ms(p50)} | ${deltaMs(p50 - M34.p50)} |`,
        `| inject p95 (ms) | ${ms(M34.p95)} | ${ms(p95)} | ${deltaMs(p95 - M34.p95)} |`,
        `| JSONL n (seeded) | ${M34.jsonlN} | ${seeded.jsonlN} | ${deltaInt(seeded.jsonlN - M34.jsonlN)} |`,
        `| JSONL n (after timed injects) | ${M34.jsonlN} | ${post.jsonlN} | ${deltaInt(post.jsonlN - M34.jsonlN)} |`,
        `| swallows (timed injects) | 0 | ${happySwallows} | ${deltaInt(happySwallows)} |`,
        `| min / max (ms) | 0.498 / 12.826 | ${ms(times[0]!)} / ${ms(times[times.length - 1]!)} | ${deltaMs(times[0]! - 0.498)} / ${deltaMs(times[times.length - 1]! - 12.826)} |`,
      ].join("\n"),
    );
    if (seeded.jsonlN < 1900) {
      console.error(`M49.2 FAIL: seeded JSONL n=${seeded.jsonlN}, want ~${STORE_2K}`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
}

measure2kStore();
