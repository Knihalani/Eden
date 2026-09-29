/**
 * NDJSON stdio bridge: MemoryAgentBench Python harness ↔ Eden BrainMemory.
 *
 * Protocol: one JSON object per line on stdin. Every reply is
 *   @@EDEN@@{"ok":true,...}\n
 * so stray logs cannot desynchronise the Python reader.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BrainMemory } from "../../src/brain-memory.ts"; // not-product
import { atomize, type IngestKind } from "./atoms.ts";

const SENTINEL = "@@EDEN@@";

type Req =
  | { op: "init" }
  | { op: "add"; text: string }
  | { op: "flush" }
  | { op: "query"; text: string; k: number; neighbors?: boolean }
  | { op: "close" };

let mem: BrainMemory | null = null;
let dir = "";
const pending: string[] = [];
let kind: IngestKind = "narrative";

function reply(obj: Record<string, unknown>) {
  process.stdout.write(SENTINEL + JSON.stringify(obj) + "\n");
}

function ensure() {
  if (!mem) throw new Error("bridge not initialized");
  return mem;
}

function ingestPending() {
  if (!pending.length) return { episodes: ensure().stored().length, kind };
  const { kind: nextKind, atoms } = atomize(pending.join("\n"));
  kind = nextKind;
  pending.length = 0;
  try { mem?.close(); } catch {}
  if (!dir) dir = mkdtempSync(join(tmpdir(), "eden-mab-"));
  mem = new BrainMemory({ dir, cortex: false, semantic: nextKind === "facts" }); // not-product
  if (atoms.length) {
    mem.ingestTurns(atoms.map((a) => ({
      text: a.text,
      speaker: "User",
      date: "",
      session: a.session,
    })));
  }
  return { episodes: mem.stored().length, kind };
}

function diversifyIcl(notes: string[], k: number, maxPer = 2): string[] {
  const count = new Map<string, number>();
  const picked: string[] = [];
  const deferred: string[] = [];
  const labelOf = (n: string) => n.match(/label:\s*(\d+)/i)?.[1] ?? "_";
  for (const n of notes) {
    const lab = labelOf(n);
    const c = count.get(lab) || 0;
    if (c < maxPer) {
      picked.push(n);
      count.set(lab, c + 1);
    } else {
      deferred.push(n);
    }
    if (picked.length >= k) break;
  }
  return picked.concat(deferred).slice(0, k);
}

function handle(req: Req) {
  switch (req.op) {
    case "init": {
      if (mem) {
        try { mem.close(); } catch {}
        try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch {}
      }
      dir = mkdtempSync(join(tmpdir(), "eden-mab-"));
      mem = new BrainMemory({ dir, cortex: false }); // not-product
      pending.length = 0;
      kind = "narrative";
      return { ok: true };
    }
    case "add": {
      pending.push(String(req.text ?? ""));
      return { ok: true, buffered: pending.length };
    }
    case "flush": {
      const stats = ingestPending();
      return { ok: true, ...stats };
    }
    case "query": {
      const stats = ingestPending();
      const m = ensure();
      const structured = stats.kind === "icl" || stats.kind === "facts";
      const kDefault = stats.kind === "icl" ? 40 : stats.kind === "facts" ? 24 : 12;
      const k = Math.max(1, Math.min(80, Number(req.k) || kDefault));
      const neighbors = req.neighbors ?? !structured;
      const pull = stats.kind === "icl" ? Math.min(80, Math.max(k * 2, 40)) : k;
      let notes = m.retrieve(String(req.text ?? ""), pull, {
        neighbors,
        complete: stats.kind === "facts",
        semantic: stats.kind === "facts",
        recency: stats.kind === "facts",
      });
      if (stats.kind === "icl") notes = diversifyIcl(notes, k);
      return { ok: true, contents: notes, kind: stats.kind, episodes: stats.episodes };
    }
    case "close": {
      try { mem?.close(); } catch {}
      try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch {}
      mem = null;
      dir = "";
      pending.length = 0;
      kind = "narrative";
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown op` };
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
