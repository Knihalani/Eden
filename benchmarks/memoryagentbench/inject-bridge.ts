/**
 * NDJSON stdio bridge: MemoryAgentBench Python harness ↔ Eden `openMemory` inject.
 *
 * Product path. Ingest = `observe` then `consolidate` (sleep gists). Query = `inject([{role:user, content:q}])`
 * then the injected `Eden Memory:` system packet. Fail-open: inject throw → empty packet.
 *
 * Protocol: one JSON object per line on stdin. Every reply is
 *   @@EDEN@@{"ok":true,...}\n
 * so stray logs cannot desynchronise the Python reader.
 *
 * k comes from env `EDEN_MEMORY_CAP` (bench sets 10). Store cap from
 * `EDEN_MEMORY_STORE_CAP` (bench sets 50000). Product defaults stay 6 / 2000.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { injectedPackets, MEMORY_MARK, openMemory, consolidate, type AgentMemory } from "../../src/index.ts";
import { atomize } from "./atoms.ts";

const SENTINEL = "@@EDEN@@";

type Req =
  | { op: "init" }
  | { op: "add"; text: string }
  | { op: "flush" }
  | { op: "query"; text: string; k?: number }
  | { op: "close" };

let mem: AgentMemory | null = null;
let dir = "";
const pending: string[] = [];
let slept = false;

function reply(obj: Record<string, unknown>) {
  process.stdout.write(SENTINEL + JSON.stringify(obj) + "\n");
}

function ensure(): AgentMemory {
  if (!mem) throw new Error("bridge not initialized");
  return mem;
}

/** The packets `inject` attached (since P0.7 at the tail of the turn's message, D29). */
function extractPacket(injected: unknown[]): string {
  return injectedPackets(Array.isArray(injected) ? injected : []).join("\n");
}

function ingestPending() {
  const m = ensure();
  if (!pending.length) return { stored: m.memories().length };
  const blob = pending.join("\n");
  pending.length = 0;
  let turns: string[] = [];
  try {
    const { atoms } = atomize(blob);
    turns = atoms.length ? atoms.map((a) => a.text) : blob.trim() ? [blob] : [];
  } catch {
    turns = blob.trim() ? [blob] : [];
  }
  // Fail-open per atom: a type crash in observe must not abort the leaf.
  // Does not change ranking; skipped atoms are simply not stored.
  try {
    m.quiet(() => {
      for (const text of turns) {
        const t = String(text ?? "").trim();
        if (!t) continue;
        try {
          m.observe([{ role: "user", content: t }]);
        } catch {}
      }
    });
  } catch {}
  return { stored: m.memories().length };
}

function handle(req: Req) {
  switch (req.op) {
    case "init": {
      if (mem) {
        try {
          mem.close();
        } catch {}
        try {
          if (dir) rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
      dir = mkdtempSync(join(tmpdir(), "eden-mab-inject-"));
      mem = openMemory({ dir });
      pending.length = 0;
      slept = false;
      return { ok: true, mark: MEMORY_MARK };
    }
    case "add": {
      pending.push(String(req.text ?? ""));
      return { ok: true, buffered: pending.length };
    }
    case "flush": {
      try {
        const stats = ingestPending();
        try {
          consolidate(ensure());
          slept = true;
        } catch {}
        return { ok: true, ...stats };
      } catch {
        return { ok: true, stored: mem?.memories().length ?? 0 };
      }
    }
    case "query": {
      const stats = ingestPending();
      if (!slept) {
        try {
          consolidate(ensure());
          slept = true;
        } catch {}
      }
      const q = String(req.text ?? "");
      let packet = "";
      try {
        const injected = ensure().inject([{ role: "user", content: q }]);
        packet = extractPacket(injected);
      } catch {
        packet = "";
      }
      return { ok: true, packet, mark: MEMORY_MARK, stored: stats.stored };
    }
    case "close": {
      try {
        mem?.close();
      } catch {}
      try {
        if (dir) rmSync(dir, { recursive: true, force: true });
      } catch {}
      mem = null;
      dir = "";
      pending.length = 0;
      slept = false;
      return { ok: true };
    }
    default:
      return { ok: false, error: "unknown op" };
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  try {
    const req = JSON.parse(raw) as Req;
    reply(handle(req));
    if (req.op === "close") process.exit(0);
  } catch (err) {
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
rl.on("close", () => process.exit(0));
