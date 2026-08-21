import type { Binding, Step, StretchProgram } from "@eden/ir/types";
import { isMutating } from "@eden/ir/names";

export const NODE_W = 184;
export const NODE_H = 72;
export const COL_GAP = 104;
export const ROW_GAP = 64;

export type GraphNode = {
  id: string;
  kind: Step["kind"];
  label: string;
  tool?: string;
  write: boolean;
  col: number;
  row: number;
  x: number;
  y: number;
};

export type GraphEdge = {
  from: string;
  to: string;
  field: string;
  path: string;
};

export type GraphLayout = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
};

function bindingDeps(b: Binding): string[] {
  if (b.kind === "from") return [b.step];
  if (b.kind === "transform") return bindingDeps(b.of);
  return [];
}

export function stepDeps(step: Step): string[] {
  if (step.kind === "tool") return Object.values(step.args).flatMap(bindingDeps);
  if (step.kind === "island") return bindingDeps(step.input);
  if (step.kind === "loop") return bindingDeps(step.over);
  return [];
}

function fromWires(step: Step): Array<{ from: string; field: string; path: string }> {
  const out: Array<{ from: string; field: string; path: string }> = [];
  const walk = (b: Binding, field: string) => {
    if (b.kind === "from") out.push({ from: b.step, field, path: b.path });
    if (b.kind === "transform") walk(b.of, field);
  };
  if (step.kind === "tool") {
    for (const [k, b] of Object.entries(step.args)) walk(b, k);
  } else if (step.kind === "island") walk(step.input, "input");
  else if (step.kind === "loop") walk(step.over, "over");
  return out;
}

function labelOf(step: Step): string {
  if (step.kind === "tool") return step.tool;
  if (step.kind === "island") return "model";
  if (step.kind === "loop") return "loop";
  return "check";
}

function isWrite(step: Step): boolean {
  return step.kind === "tool" && step.readOnly !== true && isMutating(step.tool);
}

/** Top-level method steps only — loop bodies stay inside the loop node. */
export function methodSteps(program: StretchProgram): Step[] {
  const owned = new Set<string>();
  for (const s of program.steps) {
    if (s.kind === "loop") for (const id of s.body) owned.add(id);
  }
  return program.steps.filter((s) => !owned.has(s.id));
}

export function layoutProgram(program: StretchProgram): GraphLayout {
  const steps = methodSteps(program);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ids = steps.map((s) => s.id);
  const deps = new Map<string, string[]>();
  for (const s of steps) {
    const extra =
      s.kind === "assert"
        ? (() => {
            const i = steps.findIndex((x) => x.id === s.id);
            const prev = i > 0 ? steps[i - 1] : undefined;
            return prev ? [prev.id] : [];
          })()
        : [];
    deps.set(s.id, [...new Set([...stepDeps(s).filter((id) => byId.has(id)), ...extra])]);
  }

  const col = new Map<string, number>();
  const pending = new Set(ids);
  let guard = ids.length + 2;
  while (pending.size && guard--) {
    const ready = [...pending].filter((id) => (deps.get(id) ?? []).every((p) => !pending.has(p)));
    if (!ready.length) {
      for (const id of pending) col.set(id, 0);
      break;
    }
    for (const id of ready) {
      const pred = deps.get(id) ?? [];
      col.set(id, pred.length ? Math.max(...pred.map((p) => col.get(p) ?? 0)) + 1 : 0);
      pending.delete(id);
    }
  }

  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const c = col.get(id) ?? 0;
    const list = columns.get(c) ?? [];
    list.push(id);
    columns.set(c, list);
  }

  const nodes: GraphNode[] = [];
  let maxCol = 0;
  let maxRow = 0;
  for (const [c, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    list.forEach((id, row) => {
      const step = byId.get(id)!;
      maxCol = Math.max(maxCol, c);
      maxRow = Math.max(maxRow, row);
      nodes.push({
        id,
        kind: step.kind,
        label: labelOf(step),
        tool: step.kind === "tool" ? step.tool : undefined,
        write: isWrite(step),
        col: c,
        row,
        x: c * (NODE_W + COL_GAP),
        y: row * (NODE_H + ROW_GAP),
      });
    });
  }

  const edges: GraphEdge[] = [];
  for (const s of steps) {
    for (const w of fromWires(s)) {
      if (!byId.has(w.from)) continue;
      edges.push({ from: w.from, to: s.id, field: w.field, path: w.path });
    }
  }

  return {
    nodes,
    edges,
    width: Math.max(NODE_W, (maxCol + 1) * (NODE_W + COL_GAP) - COL_GAP),
    height: Math.max(NODE_H, (maxRow + 1) * (NODE_H + ROW_GAP) - ROW_GAP),
  };
}

export function dependentsOf(program: StretchProgram, id: string): string[] {
  return methodSteps(program)
    .filter((s) => stepDeps(s).includes(id))
    .map((s) => s.id);
}

export function strippedFromMethod(program: StretchProgram): string[] {
  const kept = new Set(
    program.steps.filter((s) => s.kind === "tool").map((s) => s.tool),
  );
  return (program.sequence ?? []).filter((name) => !kept.has(name));
}

export function bindingFaults(program: StretchProgram): Array<{ field: string; message: string }> {
  const known = new Set(program.steps.map((s) => s.id));
  const faults: Array<{ field: string; message: string }> = [];
  const walk = (b: Binding, field: string) => {
    if (b.kind === "from") {
      if (!b.step) faults.push({ field, message: "Missing step." });
      else if (!known.has(b.step)) faults.push({ field, message: `Unknown step ${b.step}.` });
    }
    if (b.kind === "transform") walk(b.of, field);
  };
  for (const s of program.steps) {
    if (s.kind === "tool") {
      for (const [k, b] of Object.entries(s.args)) walk(b, `${s.id}.${k}`);
    } else if (s.kind === "island") walk(s.input, `${s.id}.input`);
    else if (s.kind === "loop") walk(s.over, `${s.id}.over`);
  }
  walk(program.returns, "returns");
  return faults;
}
