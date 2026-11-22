import type { Task } from "./ab-common";
import { isRecap } from "./pi-day";

const KINDS: Task["kind"][] = ["request", "arrival", "offworld", "hidden", "control", "neutral"];
export interface TaskSelection {
  kinds: Task["kind"][];
  mode: "full-traffic" | "reduced-traffic";
}

export function parseKinds(value: string): Task["kind"][] {
  const parts = value.split(",").map((k) => k.trim());
  if (parts.some((k) => !KINDS.includes(k as Task["kind"])))
    throw new Error(`--kinds must name ${KINDS.join(", ")} (got ${JSON.stringify(value)})`);
  return KINDS.filter((k) => parts.includes(k));
}

export function taskSelection(kinds: Task["kind"][] | null, tasks: readonly Pick<Task, "kind">[]): TaskSelection {
  return {
    kinds: kinds ?? KINDS.filter((k) => tasks.some((t) => t.kind === k)),
    mode: kinds ? "reduced-traffic" : "full-traffic",
  };
}

/** Keep every slot, including recaps: only the agent/grader execution is selected. */
export function* kindSlots<T extends Pick<Task, "kind" | "type">>(tasks: readonly T[], kinds: Task["kind"][] | null) {
  for (const task of tasks) yield { task, run: kinds === null || isRecap(task) || kinds.includes(task.kind) };
}

export function selectionKey(selection?: TaskSelection): string {
  if (!selection || selection.mode === "full-traffic") return "full-traffic";
  if (selection.mode !== "reduced-traffic") throw new Error("unknown task selection mode");
  return `reduced-traffic:${parseKinds(selection.kinds.join(",")).join(",")}`;
}

export function sameSelection(selections: readonly (TaskSelection | undefined)[]): void {
  if (new Set(selections.map(selectionKey)).size > 1)
    throw new Error(
      "task kinds/traffic differ: never pool, pair or reuse filtered and unfiltered runs (or different filters)",
    );
}

export function selectionLine(selection?: TaskSelection): string {
  return (
    `TASK KINDS: ${selection?.kinds.join(",") ?? "all (legacy)"}; ${selection?.mode ?? "full-traffic"}` +
    (selection?.mode === "reduced-traffic"
      ? "; original world, clock slots and recap mutations kept; omitted agent turns change history, Eden and connector RNG/quota state"
      : "")
  );
}
