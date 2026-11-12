/**
 * F3 (D1123): silent edits in the harnesses. A hidden task may carry its planted item's earlier version (`before`):
 * the world starts with that version at the source, Eden backfills it, and then, before the first request, the source
 * holds the edited version (the planted item as the suite wrote it) with no notice, as a calendar event moved or a
 * shared doc reworded is. Eden sees the edit only if a poll reads it (its on-demand poll at the request, or a tick).
 *
 * `<suite>+silent` gives a hand-written suite's hidden tasks a `before` made by revision.ts's fixed rule (`stale`: a
 * date two days off, a clock time an hour earlier, an amount 25% up, a count one up, else a draft), so the edit is
 * one detail and mechanical, tuned to no model. Suites written with their own `before` (F8's dev20) need nothing.
 */
import type { World, WorldItem } from "../world";
import { dress, type HiddenTask } from "./hidden-context";
import { stale } from "./revision";

type Plant = (world: World, seed: number, variant: "hidden" | "control" | "neutral") => HiddenTask[];

/** `<suite>+silent`: the base suite with each hidden task's `before`, its fact one mechanical detail earlier. */
export function withSilent(name: string, plant: Plant): Plant {
  return (world, seed, variant) => {
    const start = world.items.length;
    const tasks = plant(world, seed, variant);
    if (variant !== "hidden") return tasks;
    const planted = world.items.slice(start);
    if (planted.length !== tasks.length) throw new Error(`${name}: ${tasks.length} tasks but ${planted.length} items`);
    return tasks.map((t, k) => {
      if (t.before) return t;
      const fact = planted[k]!;
      const s = stale(fact.title, fact.text);
      // The rule can leave a text as it was ("£1k" up 25% rounds to "£1k"): then there is no edit to plant.
      if (s.title === fact.title && s.text === fact.text) return t;
      const meta = fact.meta?.start
        ? { ...fact.meta, start: new Date(Date.parse(fact.meta.start) + s.days * 86_400_000).toISOString() }
        : fact.meta;
      return { ...t, before: { title: s.title, text: s.text, ...(meta ? { meta } : {}) } };
    });
  };
}

/**
 * Puts each task's `before` at its source in place of the planted item (`plantedIds[k]` is task k's), dressed as the
 * harnesses dress planted items and dated three days earlier. Returns the edited versions by id, for `applyEdits`.
 * Call after the planted items are dressed and before the sources are built.
 */
export function plantBefore(
  world: World,
  tasks: readonly Pick<HiddenTask, "before">[],
  plantedIds: readonly (string | undefined)[],
): Map<string, WorldItem> {
  const held = new Map<string, WorldItem>();
  tasks.forEach((t, k) => {
    const id = plantedIds[k];
    if (!t.before || !id) return;
    const at = world.items.findIndex((x) => x.id === id);
    if (at < 0) return;
    const edited = world.items[at]!;
    const earlier: WorldItem = {
      ...edited,
      title: t.before.title,
      text: t.before.text,
      updatedAt: edited.updatedAt - 3 * 86_400_000,
    };
    if (t.before.meta) earlier.meta = t.before.meta;
    dress(world, earlier);
    world.items[at] = earlier;
    held.set(id, edited);
  });
  return held;
}

/**
 * The edits land: each held item's edited version replaces its earlier one at the source, updated at `at` (so a
 * listing newest first finds it). Returns the ids of the sources touched (the caller reindexes them). No notice.
 */
export function applyEdits(world: World, held: Map<string, WorldItem>, at: number): Set<string> {
  const touched = new Set<string>();
  for (const [id, edited] of held) {
    const k = world.items.findIndex((x) => x.id === id);
    if (k < 0) continue;
    world.items[k] = { ...edited, updatedAt: at };
    touched.add(edited.sourceId);
  }
  held.clear();
  return touched;
}
