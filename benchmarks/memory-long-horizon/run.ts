#!/usr/bin/env bun
/**
 * Inflated-duration coding-agent exam. Not the locked whatever harness.
 * Duration is turn count (what evicts and overwrites), not wall-clock.
 * Arms: 18 months, 36 months, 5 years. Caps: 2000 (ship) and 10000 (remember-more).
 * Inject is scored in-process AND after spawn-reload (Claude hook = new process).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_MARK, openMemory, PACKET_BYTE_CAP, PACKET_BULLET_MAX } from "../../src/index";

const WORKDAYS = 22;
const TURNS_PER_DAY = 12;
const MONTHS_18 = 18;
const MONTHS_36 = 36;
const MONTHS_60 = 60;
const TURNS_18 = MONTHS_18 * WORKDAYS * TURNS_PER_DAY; // 4752
const TURNS_36 = MONTHS_36 * WORKDAYS * TURNS_PER_DAY; // 9504
const TURNS_60 = MONTHS_60 * WORKDAYS * TURNS_PER_DAY; // 15840
const FOLDERS = ["apps/web", "apps/control", "packages/cli", "packages/wrap", "src", "benchmarks"] as const;

function packetOf(list: unknown[]): string {
  return (Array.isArray(list) ? list : [])
    .flatMap((m) => {
      if (!m || typeof m !== "object") return [];
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" ? [c] : [];
    })
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function bullets(pkt: string): string[] {
  return pkt.split("\n").filter((l) => /^\s*-\s+/.test(l));
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i),
    hi = Math.ceil(i);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

function inject(mem: ReturnType<typeof openMemory>, cue: string, files: string[]) {
  return packetOf(mem.inject([{ role: "user", content: cue, open_files: files }]));
}

function runCap(storeCap: number, turns: number): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), "eden-long-horizon-"));
  const prevCap = process.env.EDEN_MEMORY_STORE_CAP;
  const prevDir = process.env.EDEN_MEMORY_DIR;
  process.env.EDEN_MEMORY_STORE_CAP = String(storeCap);
  process.env.EDEN_MEMORY_DIR = dir;
  delete process.env.EDEN_MEMORY_CAP;
  const heap0 = process.memoryUsage();
  const t0 = performance.now();
  const mem = openMemory({ dir, cwd: "/repo" });
  mem.quiet(() => {
    mem.observe([{ role: "user", content: "Always never commit .env files." }]);
    mem.observe([{ role: "user", content: "Auth is Clerk.", open_files: ["apps/web/app/login.ts"] }]);
    mem.observe([{ role: "user", content: "Auth is none.", open_files: ["packages/cli/src/cli.ts"] }]);
    mem.observe([{ role: "user", content: "The database is sqlite.", open_files: ["packages/cli/src/home.ts"] }]);
    mem.observe([{ role: "user", content: "The database is postgres.", open_files: ["apps/web/lib/db.ts"] }]);
    for (let i = 0; i < turns; i++) {
      const folder = FOLDERS[i % FOLDERS.length]!;
      const day = Math.floor(i / TURNS_PER_DAY);
      mem.observe([
        {
          role: "user",
          content: `On day ${day} in ${folder} operator op${String(i).padStart(5, "0")} shipped file ${folder}/mod-${i % 97}.ts and left city c${i % 2000}.`,
          open_files: [`${folder}/mod-${i % 97}.ts`],
        },
      ]);
      if (i === Math.floor(turns * 0.5)) {
        mem.observe([{ role: "user", content: "Auth is Clerk.", open_files: ["apps/web/app/login.ts"] }]);
        mem.observe([{ role: "user", content: "Auth is none.", open_files: ["packages/cli/src/cli.ts"] }]);
      }
    }
    mem.observe([{ role: "user", content: "Auth is Clerk.", open_files: ["apps/web/app/login.ts"] }]);
    mem.observe([{ role: "user", content: "Auth is none.", open_files: ["packages/cli/src/cli.ts"] }]);
  });
  const writeMs = performance.now() - t0;
  const heap1 = process.memoryUsage();

  const webAuth = inject(mem, "what is auth", ["apps/web/app/login.ts"]);
  const cliAuth = inject(mem, "what is auth", ["packages/cli/src/cli.ts"]);
  const webDb = inject(mem, "what database do we use", ["apps/web/lib/db.ts"]);
  const cliDb = inject(mem, "what database do we use", ["packages/cli/src/home.ts"]);
  const pin = inject(mem, "commit these changes", ["apps/web/app/page.tsx"]);
  const buried = inject(mem, "where does operator op00042 live", ["src/index.ts"]);
  const chatter = inject(mem, "got it", ["apps/web/app/page.tsx"]);
  const xyzzy = inject(mem, "xyzzy qwerty asdfgh", ["packages/cli/src/cli.ts"]);

  const times: number[] = [];
  inject(mem, "what is auth", ["apps/web/app/login.ts"]);
  for (let i = 0; i < 21; i++) {
    const a = performance.now();
    inject(mem, "what is auth", ["apps/web/app/login.ts"]);
    times.push(performance.now() - a);
  }
  times.sort((a, b) => a - b);

  const jsonl = join(dir, "memories.jsonl");
  const semantic = join(dir, "semantic.jsonl");
  const n = existsSync(jsonl) ? readFileSync(jsonl, "utf8").split("\n").filter(Boolean).length : 0;
  const bytes = existsSync(jsonl) ? statSync(jsonl).size : 0;
  const semanticBytes = existsSync(semantic) ? statSync(semantic).size : 0;
  mem.close();

  const spawnTimes: number[] = [];
  const spawnParseTimes: number[] = [];
  const spawnTotalTimes: number[] = [];
  for (let i = 0; i < 11; i++) {
    const a = performance.now();
    const spawned = openMemory({ dir, cwd: "/repo" });
    const parsed = performance.now();
    spawnParseTimes.push(parsed - a);
    spawned.inject([{ role: "user", content: "what is auth", open_files: ["apps/web/app/login.ts"] }]);
    const done = performance.now();
    spawnTimes.push(done - parsed);
    spawnTotalTimes.push(done - a);
    spawned.close();
  }
  spawnTimes.sort((a, b) => a - b);
  spawnParseTimes.sort((a, b) => a - b);
  spawnTotalTimes.sort((a, b) => a - b);
  if (prevCap === undefined) delete process.env.EDEN_MEMORY_STORE_CAP;
  else process.env.EDEN_MEMORY_STORE_CAP = prevCap;
  if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
  else process.env.EDEN_MEMORY_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });

  const webHasClerk = /Clerk/i.test(webAuth);
  const cliHasClerk = /Clerk/i.test(cliAuth);
  const cliHasNone = /\bnone\b/i.test(cliAuth);
  const webHasPostgres = /postgres/i.test(webDb);
  const cliHasSqlite = /sqlite/i.test(cliDb);
  const pinHasEnv = /\.env/i.test(pin);
  const leak =
    cliHasClerk || (/sqlite/i.test(webDb) && /postgres/i.test(cliDb) === false && /postgres/i.test(webDb) === false);
  const packetOk =
    bullets(webAuth).length <= PACKET_BULLET_MAX && Buffer.byteLength(webAuth, "utf8") <= PACKET_BYTE_CAP;

  return {
    storeCap,
    turns,
    months: turns / (WORKDAYS * TURNS_PER_DAY),
    rows: n,
    bytes,
    writeMs: Math.round(writeMs),
    injectP50: Number(pct(times, 50).toFixed(3)),
    injectP95: Number(pct(times, 95).toFixed(3)),
    spawnParseP50: Number(pct(spawnParseTimes, 50).toFixed(3)),
    spawnParseP95: Number(pct(spawnParseTimes, 95).toFixed(3)),
    spawnInjectP50: Number(pct(spawnTimes, 50).toFixed(3)),
    spawnInjectP95: Number(pct(spawnTimes, 95).toFixed(3)),
    spawnTotalP50: Number(pct(spawnTotalTimes, 50).toFixed(3)),
    spawnTotalP95: Number(pct(spawnTotalTimes, 95).toFixed(3)),
    heapDeltaMb: Number(((heap1.heapUsed - heap0.heapUsed) / (1024 * 1024)).toFixed(2)),
    rssMb: Number((heap1.rss / (1024 * 1024)).toFixed(1)),
    semanticBytes,
    webHasClerk,
    cliHasClerk,
    cliHasNone,
    webHasPostgres,
    cliHasSqlite,
    pinHasEnv,
    buriedHit: /c00042|op00042/.test(buried),
    chatterSilent: !chatter.includes(MEMORY_MARK),
    xyzzySilent: !xyzzy.includes(MEMORY_MARK),
    packetOk,
    siblingAuthLeak: cliHasClerk,
    scopedAuthOk: webHasClerk && cliHasNone && !cliHasClerk,
    scopedDbOk: webHasPostgres && cliHasSqlite && !/postgres/i.test(cliDb) && !/sqlite/i.test(webDb),
    leak,
  };
}

const cap2k = runCap(2000, TURNS_18);
const cap10k = runCap(10_000, TURNS_18);
const cap2k36 = runCap(2000, TURNS_36);
const cap2k60 = runCap(2000, TURNS_60);
const cap10k60 = runCap(10_000, TURNS_60);

const out = {
  protocol: {
    workdaysPerMonth: WORKDAYS,
    turnsPerDay: TURNS_PER_DAY,
    folders: FOLDERS,
    arms: {
      months18: { months: MONTHS_18, turns: TURNS_18 },
      months36: { months: MONTHS_36, turns: TURNS_36 },
      years5: { months: MONTHS_60, turns: TURNS_60 },
    },
    note: "Duration is turn count, not wall-clock. Place cues today are filenames only; directory is not a retrieve scope. spawnParse = openMemory JSONL load; spawnInject = inject after that load (Claude hook is a new process).",
  },
  cap2000_18mo: cap2k,
  cap10000_18mo: cap10k,
  cap2000_36mo: cap2k36,
  cap2000_5y: cap2k60,
  cap10000_5y: cap10k60,
};

console.log(JSON.stringify(out, null, 2));
console.log(`metric: ${out.cap2000_18mo.scopedAuthOk && out.cap2000_18mo.scopedDbOk ? 0 : 1}`);
console.log(`ms: ${out.cap2000_18mo.injectP50}`);
console.log(`spawnMs: ${out.cap2000_18mo.spawnParseP50}`);
console.log(`bytes: ${out.cap2000_18mo.bytes}`);
console.log(`n: ${out.cap2000_18mo.rows}`);
