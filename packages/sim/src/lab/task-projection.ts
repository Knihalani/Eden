import type { RunResult, Task } from "./ab-common";
import { kindSlots, type TaskSelection } from "./task-kinds";

export interface ProjectionSource {
  model: string;
  grader: string;
  spent: number;
  partial?: boolean;
  spend?: { grader: number };
  tasks: Pick<Task, "id" | "kind">[];
  results: Pick<RunResult, "task" | "condition" | "costUsd" | "edenCostUsd" | "error">[];
}

/** Historical per-kind means, keeping the reference's recap/backfill/background spend fixed. Not a spend cap. */
export function projectTasks(
  source: ProjectionSource,
  tasks: readonly Task[],
  conditions: readonly string[],
  selection: TaskSelection,
  models: { model: string; grader: string },
) {
  if (source.model !== models.model || source.grader !== models.grader)
    throw new Error("--project-from needs the same agent and grader models");
  if (source.partial || !source.results.length || source.results.some((r) => r.error))
    throw new Error("--project-from needs a complete, error-free reference run");
  const priorConditions = [...new Set(source.results.map((r) => r.condition))];
  if (conditions.length !== priorConditions.length || conditions.some((c) => !priorConditions.includes(c)))
    throw new Error("--project-from needs the same conditions (fixed recap/background costs are retained)");
  if (
    !Number.isFinite(source.spent) ||
    source.spent < 0 ||
    !Number.isFinite(source.spend?.grader) ||
    source.spend!.grader < 0
  )
    throw new Error("--project-from needs measured total and grader spend");
  const priorTasks = new Map(source.tasks.map((t) => [t.id, t]));
  if (
    tasks.length !== source.tasks.length ||
    tasks.some((t, i) => source.tasks[i]?.id !== t.id || source.tasks[i]?.kind !== t.kind)
  )
    throw new Error("--project-from needs the same full task plan/horizon; filtering must not rebuild it");
  const grade = source.spend!.grader / source.results.length;
  const groups = new Map<string, number[]>();
  let variable = 0;
  for (const r of source.results) {
    const t = priorTasks.get(r.task);
    const cost = r.costUsd + (r.edenCostUsd ?? 0) + grade;
    if (!t || !Number.isFinite(cost) || cost < 0) throw new Error("--project-from has invalid task costs");
    const key = `${r.condition}:${t.kind}`;
    const group = groups.get(key) ?? [];
    group.push(cost);
    groups.set(key, group);
    variable += cost;
  }
  const fixedUsd = Math.max(0, source.spent - variable);
  const selected = [...kindSlots(tasks, selection.mode === "full-traffic" ? null : selection.kinds)]
    .filter((s) => s.run)
    .map((s) => s.task);
  let selectedUsd = 0;
  for (const c of conditions)
    for (const t of selected) {
      const group = groups.get(`${c}:${t.kind}`);
      if (!group?.length) throw new Error(`--project-from has no ${c}/${t.kind} observations`);
      selectedUsd += group.reduce((a, b) => a + b, 0) / group.length;
    }
  return { tasks: selected.length * conditions.length, fixedUsd, projectedUsd: fixedUsd + selectedUsd };
}
