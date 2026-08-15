import type { CompiledStep } from "./types";

export type DagNode = CompiledStep & { deps: string[] };

function priorStepRefs(step: CompiledStep): string[] {
  const blobs = [...Object.values(step.bind ?? {}), step.url, step.command, JSON.stringify(step.body ?? null)];
  const ids: string[] = [];
  for (const raw of blobs) {
    if (!raw) continue;
    const re = /\{\{(\w+)\./g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(raw)))) ids.push(m[1]);
  }
  return [...new Set(ids)];
}

export function buildDag(steps: CompiledStep[]): DagNode[] {
  return steps.map((step, i) => {
    const deps: string[] = priorStepRefs(step);
    if (deps.length === 0 && i > 0 && !step.commute) {
      const prev = steps[i - 1];
      if (!prev.commute) deps.push(prev.id);
    }
    return { ...step, deps };
  });
}

export function layers(nodes: DagNode[]): DagNode[][] {
  const done = new Set<string>();
  const remaining = [...nodes];
  const out: DagNode[][] = [];
  while (remaining.length) {
    const ready = remaining.filter((n) => n.deps.every((d) => done.has(d)));
    if (ready.length === 0) {
      out.push([remaining.shift()!]);
      done.add(out[out.length - 1][0].id);
      continue;
    }
    out.push(ready);
    for (const n of ready) {
      done.add(n.id);
      const idx = remaining.indexOf(n);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }
  return out;
}

export function billableMs(opts: {
  server_ms: number;
  steps_attempted: number;
  densified_bytes: number;
}): number {
  return Math.max(0, Math.round(opts.server_ms + 25 * opts.steps_attempted + opts.densified_bytes / 200));
}
