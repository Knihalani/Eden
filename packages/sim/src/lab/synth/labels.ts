/**
 * Ground truth from construction (D881). LAB ONLY. For every (request, item) pair of a world: `changes` when the item
 * is the request's task's planted fact, `clear` when it is that task's decoy or one of its neutral items (relevant,
 * all clear), `unrelated` otherwise. No model judges a label. `visible` says whether the item existed when the
 * request was made (a late or multiday fact is pushed context for the first request, retrieved for the follow-up);
 * for a silent change the earlier revision is visible only until the edit lands, the edit only after.
 */
import type { SynthWorld } from "./schema";
import type { Label } from "./taxonomy";

export interface Pair {
  world: string;
  request: string;
  item: string;
  label: Label;
  /** fact | decoy | neutral (of the request's own task), or other (another task's item or background). */
  role: "fact" | "decoy" | "neutral" | "other";
  visible: boolean;
}

export function pairsOf(w: SynthWorld): Pair[] {
  const items = new Map(w.items.map((i) => [i.id, i]));
  // An item an edit replaced is gone once the edit lands: visible from its own time until the edit's.
  const replacedAt = new Map<string, number>();
  for (const i of w.items) if (i.revisionOf) replacedAt.set(i.revisionOf, i.at);
  const out: Pair[] = [];
  for (const t of w.tasks) {
    const neutrals = new Set(t.neutrals);
    for (const r of t.requests)
      for (const i of w.items) {
        const role = i.id === t.fact ? "fact" : i.id === t.decoy ? "decoy" : neutrals.has(i.id) ? "neutral" : "other";
        const label: Label = role === "fact" ? "changes" : role === "other" ? "unrelated" : "clear";
        const gone = replacedAt.get(i.id);
        const visible = items.get(i.id)!.at <= r.at && (gone === undefined || gone > r.at);
        out.push({ world: w.id, request: r.id, item: i.id, label, role, visible });
      }
  }
  return out;
}

export function countPairs(w: SynthWorld) {
  const c = { pairs: 0, changes: 0, clear: 0, unrelated: 0, visible: 0 };
  for (const p of pairsOf(w)) {
    c.pairs++;
    c[p.label]++;
    if (p.visible) c.visible++;
  }
  return c;
}
