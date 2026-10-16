#!/usr/bin/env bun
/**
 * 2k-store accuracy / speed / bytes. Prints metric: (misses, lower is better),
 * ms: (inject p50), bytes: (JSONL size). Out of scope — do not optimize this file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_MARK,
  memoryInjectSwallows,
  memoryStoreCap,
  openMemory,
  PACKET_BYTE_CAP,
  PACKET_BULLET_MAX,
} from "../../src/index";
import { storeFor } from "../../src/memory-repo";
import { memoryHookResponse } from "../../packages/cli/src/memory-hook";
import { withKnowFacts } from "../../packages/wrap/src/know-inject";

const STORE_N = 2000;
const EXTRA = 80;
const GOLD = 42;
const EARLY = 5;

/** The packet text: since P0.7 it ends the turn's message (D29), so it is read from its header on. */
function packetOf(list: unknown[]): string {
  return (Array.isArray(list) ? list : [])
    .flatMap((m) => {
      if (!m || typeof m !== "object") return [];
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" ? [c] : [];
    })
    .filter((c) => c.includes(MEMORY_MARK))
    .map((c) => c.slice(c.indexOf(MEMORY_MARK)))
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

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

const dir = mkdtempSync(join(tmpdir(), "eden-whatever-scale-"));
const prevDir = process.env.EDEN_MEMORY_DIR;
const prevCap = process.env.EDEN_MEMORY_STORE_CAP;
process.env.EDEN_MEMORY_DIR = dir;
delete process.env.EDEN_MEMORY_STORE_CAP;
process.env.EDEN_KNOW = "0";

let misses = 0;
const hit = (ok: boolean) => {
  if (!ok) misses++;
};

try {
  // The wrap and the hook below read the store of this process's repo (D1, since P0.5), so the bench seeds that one.
  const mem = openMemory({ dir: storeFor(dir), perRepo: true });
  mem.quiet(() => {
    for (let i = 0; i < STORE_N; i++) {
      mem.observe([{ role: "user", content: `Operator op${pad(i)} lives in city c${pad(i)}.` }]);
    }
  });
  mem.observe([{ role: "user", content: "Auth is Clerk." }]);
  mem.observe([{ role: "user", content: "The database is postgres." }]);
  mem.observe([{ role: "user", content: "The database is sqlite instead of postgres." }]);

  const cue42 = `Where does operator op${pad(GOLD)} live?`;
  for (let i = 0; i < EXTRA; i++) mem.inject([{ role: "user", content: cue42 }]);

  const pkt42 = packetOf(mem.inject([{ role: "user", content: cue42 }]));
  const pktPara = packetOf(mem.inject([{ role: "user", content: `which city is op${pad(GOLD)} in?` }]));
  const pktEarly = packetOf(mem.inject([{ role: "user", content: `Where does operator op${pad(EARLY)} live?` }]));
  const pktLate = packetOf(mem.inject([{ role: "user", content: `Where does operator op1990 live?` }]));
  const pktAuth = packetOf(mem.inject([{ role: "user", content: "what is auth" }]));
  const pktDb = packetOf(mem.inject([{ role: "user", content: "what database do we use" }]));
  const xyzzy = packetOf(mem.inject([{ role: "user", content: "xyzzy qwerty asdfgh" }]));
  const chatter = packetOf(mem.inject([{ role: "user", content: "got it" }]));
  const math = packetOf(mem.inject([{ role: "user", content: "what's 2+2?" }]));

  hit(pkt42.includes(MEMORY_MARK) && /c0042/.test(pkt42) && !/c1983|c1993/.test(pkt42));
  hit(pktPara.includes(MEMORY_MARK) && /c0042/.test(pktPara));
  hit(pktEarly.includes(MEMORY_MARK) && /c0005/.test(pktEarly));
  hit(pktLate.includes(MEMORY_MARK) && /c1990/.test(pktLate));
  hit(/Clerk/i.test(pktAuth));
  hit(/sqlite/i.test(pktDb) && !/postgres/i.test(pktDb));
  hit(!xyzzy.includes(MEMORY_MARK));
  hit(!chatter.includes(MEMORY_MARK));
  hit(!math.includes(MEMORY_MARK));
  hit(bullets(pkt42).length <= PACKET_BULLET_MAX && Buffer.byteLength(pkt42, "utf8") <= PACKET_BYTE_CAP);
  hit(pkt42.startsWith(MEMORY_MARK));

  const wrap = withKnowFacts({ messages: [{ role: "user", content: "what is auth" }] }) as { messages?: unknown[] };
  hit(/Clerk/i.test(packetOf(wrap.messages ?? [])));
  const hook = memoryHookResponse({ hook_event_name: "UserPromptSubmit", prompt: "what is auth" });
  const ctx =
    hook && typeof hook === "object" && "hookSpecificOutput" in hook
      ? String(
          (hook as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "",
        )
      : "";
  hit(/Clerk/i.test(ctx));
  const before = memoryInjectSwallows.n;
  const boom = mem.inject({ not: "array" } as unknown as unknown[]);
  hit(Array.isArray(boom) && memoryInjectSwallows.n >= before);

  const times: number[] = [];
  mem.inject([{ role: "user", content: cue42 }]);
  for (let i = 0; i < 21; i++) {
    const t0 = performance.now();
    packetOf(mem.inject([{ role: "user", content: cue42 }]));
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = pct(times, 50);

  const jsonl = join(storeFor(dir), "memories.jsonl");
  const n = existsSync(jsonl) ? readFileSync(jsonl, "utf8").split("\n").filter(Boolean).length : 0;
  const bytes = existsSync(jsonl) ? statSync(jsonl).size : 0;
  // D33's store cap: 2,000 rows (STORE_N) until P4.2 raised it to 20,000 (the user's choice, 2026-10-16).
  hit(n <= memoryStoreCap());

  console.log(`metric: ${misses}`);
  console.log(`ms: ${p50.toFixed(3)}`);
  console.log(`bytes: ${bytes}`);
  console.log(`n: ${n}`);
} finally {
  if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
  else process.env.EDEN_MEMORY_DIR = prevDir;
  if (prevCap === undefined) delete process.env.EDEN_MEMORY_STORE_CAP;
  else process.env.EDEN_MEMORY_STORE_CAP = prevCap;
  rmSync(dir, { recursive: true, force: true });
}
