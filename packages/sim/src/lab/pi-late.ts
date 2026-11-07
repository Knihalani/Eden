/**
 * `pi-ab --day K --late` (A9, docs/research/a9-ahead.md): plan-conflict proactivity's test. The planted item of each
 * request (the hidden fact, or the control's look-alike) is not in the world when the request is made: it arrives
 * right after the agent answers it, as a new item at its source (with `--push payload` its notice carries it, as a
 * Slack event or a trigger's payload would), and the day goes on with other requests and the recap. Whether the agent
 * then corrects course is graded on what it says after the item arrived: the later answers of that day and the recap,
 * against the planted request's own facts (`lateFacts` on that request's result). On a hidden day that is the fact
 * reaching the user late; on a control day it is a false alarm about the look-alike.
 *
 * The request's own answer is graded as usual and is expected to miss the fact (it did not exist yet).
 */
import type { Task } from "./ab-common";
import type { World, WorldItem } from "../world";

/** The planted items of `tasks` taken out of `world.items` (in place), by id, to be released one by one. */
export function holdPlanted(world: World, tasks: readonly Task[]): Map<string, WorldItem> {
  const ids = new Set(tasks.flatMap((t) => (t.planted ? [t.planted] : [])));
  const held = new Map<string, WorldItem>();
  world.items = world.items.filter((it) => {
    if (!ids.has(it.id)) return true;
    held.set(it.id, it);
    return false;
  });
  return held;
}

/** Releases `id` into `world` at time `at` (it is new at its source then); null when it is not held (or already out). */
export function release(world: World, held: Map<string, WorldItem>, id: string, at: number): WorldItem | null {
  const it = held.get(id);
  if (!it) return null;
  held.delete(id);
  const out = { ...it, updatedAt: at };
  world.items.push(out);
  return out;
}

/** One late-planted request of a day, and the agent's answers after its item arrived. */
export interface LateEntry {
  task: Task;
  after: string[];
}

/** What the grader reads for a late entry: the later answers in order, each headed by its turn. */
export function laterText(entry: LateEntry): string {
  return entry.after
    .map((a, i) => (a.trim() ? `[Later reply ${i + 1}]\n${a.trim()}` : ""))
    .filter(Boolean)
    .join("\n\n");
}
