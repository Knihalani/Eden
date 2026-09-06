import type { CompiledStep } from "./types";

export type DagNode = CompiledStep & { deps: string[] };

function priorStepRefs(step: CompiledStep): string[] {
  const blobs = [...Object.values(step.bind ?? {}), step.url, step.command, JSON.stringify(step.body ?? null)];
  const ids: string[] = [];
  for (const raw of blobs) {
    if (!raw) continue;
    const re = /\{\{(\w+)\./g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(String(raw)))) ids.push(m[1]!);
  }
  return [...new Set(ids)];
}

/**
 * An order-dependent step must not start before the last order-dependent step
 * ahead of it has finished.
 *
 * This used to look only at the immediately preceding step and give up if that
 * one happened to commute, which is not the same question. For
 * `[A(ordered), B(commutes), C(ordered)]`, C got no dependency at all and
 * landed in the same layer as A — and layers are run through Promise.all, so
 * two steps that each declared themselves order-dependent executed
 * concurrently. Mixed islands are the normal case, since reads are marked
 * commuting and writes are not, so this was the common shape rather than an
 * exotic one.
 */
function lastOrderedBefore(steps: CompiledStep[], i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    if (!steps[j]!.commute) return steps[j]!.id;
  }
  return undefined;
}

export function buildDag(steps: CompiledStep[]): DagNode[] {
  return steps.map((step, i) => {
    let deps = priorStepRefs(step);
    // The sequential edge is not a fallback for steps with no data deps — it
    // holds *in addition* to them. A non-commuting step whose data deps point
    // at earlier commuting reads used to skip this edge and land in the same
    // parallel wave as another non-commuting step, so two writes raced through
    // Promise.all. Order-dependent steps queue behind each other regardless of
    // what else they wait on.
    if (i > 0 && !step.commute) {
      const prev = lastOrderedBefore(steps, i);
      if (prev !== undefined) deps = deps.concat(prev);
    }
    return { ...step, deps: [...new Set(deps)] };
  });
}

/**
 * Kahn's algorithm: group the steps into waves that may each run concurrently.
 *
 * This is also the only cycle detector in the system — a dependency that can
 * never be satisfied surfaces here as a throw rather than as a hang.
 */
export function layers(nodes: DagNode[]): DagNode[][] {
  const dependents = new Map<string, DagNode[]>();
  const outstanding = new Map<string, number>();
  const ready: DagNode[] = [];

  for (const n of nodes) {
    // Every distinct dep is counted, including one naming a step that is not
    // in this set and one naming the step itself. Neither can ever be
    // decremented, so such a node stays outstanding and is reported by the
    // completeness check below — the same "unresolvable step deps" throw the
    // previous implementation produced by never finding it ready.
    const deps = [...new Set(n.deps)];
    outstanding.set(n.id, deps.length);
    if (deps.length === 0) ready.push(n);
    for (const d of deps) {
      const list = dependents.get(d);
      if (list) list.push(n);
      else dependents.set(d, [n]);
    }
  }

  const out: DagNode[][] = [];
  let frontier = ready;
  let placed = 0;
  while (frontier.length) {
    out.push(frontier);
    placed += frontier.length;
    const next: DagNode[] = [];
    for (const n of frontier) {
      for (const d of dependents.get(n.id) ?? []) {
        const left = (outstanding.get(d.id) ?? 0) - 1;
        outstanding.set(d.id, left);
        if (left === 0) next.push(d);
      }
    }
    frontier = next;
  }

  if (placed !== nodes.length) {
    const stuck = nodes.filter((n) => (outstanding.get(n.id) ?? 0) > 0).map((n) => n.id);
    throw new Error(`unresolvable step deps: ${stuck.join(",")}`);
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
