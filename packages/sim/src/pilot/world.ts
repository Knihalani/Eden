/**
 * The pilot's import as a lab world (F3, D489): the same `{world, tasks}` the Pi harness runs for a generated user, so
 * the owner's real requests go through the standard agent loop, arms and cost accounting (`pi-ab --world-file`). The
 * items are served by the lab's simulated connectors (their search and latency profiles) from the redacted import;
 * no connector is called during a run.
 */
import { itemId } from "@eden/protocol";
import type { Task } from "../lab/ab-common";
import type { ItemKind, World, WorldItem } from "../world";
import type { PilotItem, PilotMeta, PilotTask } from "./store";

const KIND: Record<string, ItemKind> = { gmail: "mail", calendar: "event", drive: "doc", crm: "deal", slack: "chat" };

export interface PilotBundle {
  meta: PilotMeta;
  items: PilotItem[];
  tasks: PilotTask[];
}

/** A task id is the owner's own short name; in results it is `pilot:<id>`. */
export const taskId = (id: string) => `pilot:${id}`;

export function worldFromPilot(bundle: PilotBundle, seed = 1): { seed: number; world: World; tasks: Task[] } {
  const { meta, items } = bundle;
  const first = meta.user.name.trim().split(/\s+/)[0] ?? meta.user.name;
  const last = meta.user.name.trim().split(/\s+/).slice(1).join(" ");
  const worldItems: WorldItem[] = items.map((i) => ({
    id: itemId(i.sourceId, i.ref),
    sourceId: i.sourceId,
    ref: i.ref,
    title: i.title,
    text: i.text,
    updatedAt: i.updatedAt,
    ...(i.url ? { url: i.url } : {}),
    kind: KIND[i.sourceId] ?? "doc",
    facts: [],
    noise: false,
    ...(i.meta ? { meta: i.meta } : {}),
  }));
  const world: World = {
    seed,
    now: meta.importedAt,
    user: { id: "self", first, last, full: meta.user.name, email: meta.user.email, relation: "self" },
    people: [],
    arcs: [],
    facts: new Map(),
    items: worldItems,
    sources: { ...meta.sources },
  };
  const tasks: Task[] = bundle.tasks.map((t) => ({
    id: taskId(t.id),
    suite: "pilot",
    // A request with facts that mattered is graded as a hidden-context task; one with none is a neutral request,
    // where the only thing to get wrong is raising a concern (the owner marks it; no model grades it).
    kind: t.facts.length ? "hidden" : "neutral",
    type: t.id,
    event: "user_message",
    text: t.text,
    must: t.facts.map((f) => ({ id: f.id, detail: f.detail })),
    secrets: [],
  }));
  return { seed, world, tasks };
}

/** `pi-ab --world-file F`: the bundle file the pilot's `run` writes into its run directory. */
export function readBundle(text: string): PilotBundle {
  const b = JSON.parse(text) as Partial<PilotBundle>;
  if (!b.meta?.user?.name || !Array.isArray(b.items) || !Array.isArray(b.tasks)) {
    throw new Error("not a pilot bundle: it needs meta.user, items and tasks (written by `pilot run`)");
  }
  return b as PilotBundle;
}
