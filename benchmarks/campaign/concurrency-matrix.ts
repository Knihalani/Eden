/**
 * Wave 4.1 — concurrency matrix gate.
 *
 * Grid: stretches {1..200} × tails {2..40} × think {0,120ms} × armings {≤64, >64}.
 * CI runs every corner of that range plus a sampled interior. `--full` samples
 * more interior cells. A red cell is a bug with a pinned repro, not a tolerance
 * change. Exactly-once is the only pass.
 *
 *   bun test benchmarks/campaign/concurrency-matrix.test.ts
 *   bun run benchmarks/campaign/concurrency-matrix.ts          # report
 */
import { createArmingStore, createState, wrapTools, type ToolDef } from "@eden/wrap";
import { fireOblivious, linearProgram } from "./struggle-harness";

export type MatrixCell = {
  stretches: number;
  tail: number;
  thinkMs: number;
  /** "one" = one session (A3 fail-open past 64). "hosted" = one session per stretch. */
  mode: "one" | "hosted";
};

export type CellResult = MatrixCell & {
  ok: boolean;
  ms: number;
  duplicates: string[];
  capacityMisses: number;
};

const WRITE = "write";

export function cornerCells(): MatrixCell[] {
  const stretches = [1, 8, 32, 64, 65, 100, 200];
  const tails = [2, 8, 32, 40];
  const cells: MatrixCell[] = [];
  for (const s of stretches) {
    for (const t of tails) {
      cells.push({ stretches: s, tail: t, thinkMs: 0, mode: s > 64 ? "one" : "one" });
      if (s > 64) cells.push({ stretches: s, tail: t, thinkMs: 0, mode: "hosted" });
    }
  }
  // Think-time subset: cheap cells only (120ms × long tails × W=200 is a soak, not CI).
  for (const s of [1, 8]) {
    for (const t of [2, 8]) {
      cells.push({ stretches: s, tail: t, thinkMs: 120, mode: "one" });
    }
  }
  return cells;
}

/** Interior samples from the full {1..200}×{2..40}×{0,120}×{≤64,>64} cube. */
export function interiorCells(seed = 0x4a41, n = 8): MatrixCell[] {
  let x = seed >>> 0;
  const next = (): number => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
  const cells: MatrixCell[] = [];
  for (let i = 0; i < n; i++) {
    const stretches = 1 + (next() % 200);
    const tail = 2 + (next() % 39);
    const thinkMs = next() % 5 === 0 && stretches <= 8 && tail <= 8 ? 120 : 0;
    const mode: MatrixCell["mode"] = stretches > 64 && next() % 2 === 0 ? "hosted" : "one";
    cells.push({ stretches, tail, thinkMs, mode });
  }
  return cells;
}

export async function runCell(cell: MatrixCell): Promise<CellResult> {
  const t0 = performance.now();
  const sequence = ["lookup", ...Array.from({ length: cell.tail }, (_, i) => (i === cell.tail - 1 ? WRITE : `step${i}`))];
  const writes: Record<string, number> = {};
  const tools: Record<string, ToolDef> = {};
  for (const name of sequence) {
    tools[name] = {
      description: name,
      execute: async (args: Record<string, unknown>) => {
        if (name === WRITE) {
          const id = String(args.id);
          writes[id] = (writes[id] ?? 0) + 1;
        }
        return { name, id: args.id };
      },
    };
  }
  const prog = linearProgram("p_matrix", sequence, { text: true });
  const arming = createArmingStore();
  let capacityMisses = 0;

  const script = (id: string) =>
    sequence.map((tool) => ({
      tool,
      args: tool === "lookup" ? { id, text: "t" } : { id },
    }));

  if (cell.mode === "hosted") {
    await Promise.all(
      Array.from({ length: cell.stretches }, (_, i) => {
        const state = createState({ programs: [prog], arming, sessionId: `m-${i}` });
        const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;
        return fireOblivious(wrapped, script(`M-${i}`), cell.thinkMs).then(() => {
          capacityMisses += state.capacityMisses;
        });
      }),
    );
  } else {
    const state = createState({ programs: [prog], arming, sessionId: "one" });
    const wrapped = wrapTools(tools, state) as Record<string, ToolDef>;
    await Promise.all(
      Array.from({ length: cell.stretches }, (_, i) => fireOblivious(wrapped, script(`M-${i}`), cell.thinkMs)),
    );
    capacityMisses = state.capacityMisses;
  }

  const duplicates: string[] = [];
  for (let i = 0; i < cell.stretches; i++) {
    const id = `M-${i}`;
    const n = writes[id] ?? 0;
    if (n !== 1) duplicates.push(`${id}:${n}`);
  }
  return { ...cell, ok: duplicates.length === 0, ms: performance.now() - t0, duplicates, capacityMisses };
}

export function cellLabel(c: MatrixCell): string {
  return `W=${c.stretches} tail=${c.tail} think=${c.thinkMs} mode=${c.mode}`;
}

if (import.meta.main) {
  const full = process.argv.includes("--full");
  const cells = full ? [...cornerCells(), ...interiorCells(0x4a41, 24)] : [...cornerCells(), ...interiorCells()];
  console.log(`Concurrency matrix — ${cells.length} cells full=${full}`);
  const red: string[] = [];
  for (const cell of cells) {
    const r = await runCell(cell);
    const mark = r.ok ? "OK" : "RED";
    console.log(`  ${mark} ${cellLabel(cell)} ${r.ms.toFixed(0)}ms misses=${r.capacityMisses}${r.ok ? "" : " " + r.duplicates.join(",")}`);
    if (!r.ok) red.push(cellLabel(cell));
  }
  console.log(red.length ? `MATRIX RED: ${red.join("; ")}` : "MATRIX GREEN");
  if (red.length) process.exitCode = 1;
}
