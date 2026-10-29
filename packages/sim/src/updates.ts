/**
 * Items that change at the source after Eden may have cached them: a meeting moved, an appointment rescheduled, a
 * call or flight retimed. Without these the simulation never shows a stale cached copy, so a refresh policy has
 * nothing to fix.
 *
 * An update replaces a fact whose detail holds a clock time (`12:30`) with a new version (`fact@v2`, the time moved
 * one to three hours later) before a chosen session. From that session on, the source serves the new text, the labels
 * ask for the new fact, and an agent's own tool sees the new text. A copy Eden cached before still holds the old time:
 * scoring reads which version a delivered, cached or judged text shows (`factsShown`), so a stale copy states the old
 * fact, which no later turn needs.
 */
import { Rng } from "./rng";
import type { AskCase, SimSession } from "./sessions";
import type { World, WorldItem } from "./world";

export interface FactUpdate {
  /** Index of the first session that sees the new version. */
  session: number;
  fact: string;
  next: string;
  /** The clock time in the old text, and its replacement. */
  from: string;
  to: string;
  /** Items that state the fact and hold `from`. */
  items: string[];
}

const CLOCK = /\b([01]\d|2[0-3]):([0-5]\d)\b/;

/**
 * Which facts get a new version, and before which session: each fact with a clock time in its detail and in the text
 * of an item stating it, with probability `rate`. Adds the new facts to the world (stated by no item until applied).
 */
export function planUpdates(world: World, sessions: number, seed: number, rate: number): FactUpdate[] {
  if (!(rate > 0) || sessions < 2) return [];
  const r = new Rng(seed);
  const byId = new Map(world.items.map((i) => [i.id, i]));
  const out: FactUpdate[] = [];
  for (const f of [...world.facts.values()]) {
    const m = CLOCK.exec(f.detail);
    if (!m) continue;
    const from = m[0];
    const items = f.items.filter((id) => byId.get(id)?.text.includes(from));
    if (items.length === 0 || !r.chance(rate)) continue;
    const to = `${String((Number(m[1]) + r.int(1, 3)) % 24).padStart(2, "0")}:${m[2]}`;
    const next = `${f.id}@v2`;
    world.facts.set(next, { id: next, detail: f.detail.replace(from, to), items: [...items] });
    out.push({ session: r.int(1, sessions - 1), fact: f.id, next, from, to, items });
  }
  return out;
}

/** Labels, fetched facts and tool output in sessions from each update's session on (and every ask) use the new fact. */
export function relabel(sessions: SimSession[], asks: AskCase[], updates: FactUpdate[]): void {
  for (const u of updates) {
    const swap = (fs: string[]) => fs.map((f) => (f === u.fact ? u.next : f));
    for (let s = u.session; s < sessions.length; s++) {
      for (const task of sessions[s]!.tasks) {
        for (const turn of task.turns) {
          const l = turn.label;
          if (l.kind === "need") turn.label = { ...l, must: swap(l.must), ok: swap(l.ok) };
          else if (l.kind === "context") turn.label = { ...l, ok: swap(l.ok) };
          if (turn.uses) turn.uses = swap(turn.uses);
          if (turn.fetched?.includes(u.fact)) {
            turn.fetched = swap(turn.fetched);
            const ev = turn.event;
            if (ev.kind === "tool_result" && typeof ev.output === "string") {
              turn.event = { ...ev, output: ev.output.replaceAll(u.from, u.to) };
            }
          }
        }
      }
    }
    for (const a of asks) {
      a.must = swap(a.must);
      a.ok = swap(a.ok);
    }
  }
}

/** Changes the world's items to the new version (the source now serves it). Returns the source ids touched. */
export function applyUpdate(world: World, u: FactUpdate, at: number): Set<string> {
  const touched = new Set<string>();
  for (const it of world.items) {
    if (!u.items.includes(it.id)) continue;
    it.text = it.text.replaceAll(u.from, u.to);
    it.facts = it.facts.map((f) => (f === u.fact ? u.next : f));
    it.updatedAt = at;
    touched.add(it.sourceId);
  }
  return touched;
}

/**
 * The facts a text showing `item` states, given the updates applied so far: the item's current facts, except that a
 * text still holding an update's old time (and not its new one) states the old fact.
 */
export function factsShown(item: WorldItem, text: string, applied: readonly FactUpdate[]): string[] {
  let facts = item.facts;
  for (const u of applied) {
    if (!u.items.includes(item.id) || !text.includes(u.from) || text.includes(u.to)) continue;
    facts = facts.map((f) => (f === u.next ? u.fact : f));
  }
  return facts;
}
