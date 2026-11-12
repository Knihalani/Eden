/**
 * `pi-ab --days D` (H16, CL5, docs/research/cl-cl5.md): a long horizon as one user lives it. One world per seed holds
 * the user's whole run: D days of 12–20 requests each (`--day-size`), every day mixing hidden, control and neutral
 * requests in the assumed traffic proportion (`--mix`, 1:1:8). The requests are the train suites' templates (any
 * suites that build `neutral`), each used once per user, drawn without replacement from the suites named.
 *
 * What persists and what resets:
 * - Eden: one partner per stream (the user), so its sync, cache, cards and intent index live across all D days; the
 *   cards and intent for the user's items are made (or replayed) once, before the first request. Each day is one
 *   Eden session (`w<seed>:user:day<d>`).
 * - The agent: its transcript resets each day (a new agent session per day, as a personal assistant opening a new
 *   conversation each morning); within a day it keeps every earlier request, tool result and packet. Not compacted.
 * - The world: the planted items of a day move their clock times before that day's recap (pi-day.ts) and stay moved.
 *
 * The world's "now" is fixed (it does not evolve), so Eden's clock moves `gapMin` minutes a request and `nightH` hours
 * between days: a week of clock drift would age every item against requests written for that fixed now.
 *
 * A combined world can put one template's planted event in another request's calendar slot; `userWorldOf` clears
 * slots as worldOf does (keeping every planted item) and counts those clashes, so a run can say how many there were.
 */
import { itemId } from "@eden/protocol";
import { Rng } from "../rng";
import { buildWorld, type World, type WorldItem } from "../world";
import type { Task } from "./ab-common";
import { clearSlot, dress } from "./hidden-context";
import { supportsNeutral } from "./neutral";
import { preparedWorld, prepareWorld, SUITES, type Variant } from "./suites";

export interface UserPlanEntry {
  suite: string;
  template: string;
  variant: Variant;
}

export interface UserOptions {
  days: number;
  /** Requests per day, inclusive range. */
  size: [number, number];
  /** Shares of hidden, control and neutral (any scale: 1:1:8). */
  mix: { hidden: number; control: number; neutral: number };
}

/** `"12-20"` → [12, 20]; `"16"` → [16, 16]. */
export function parseDaySize(arg: string): [number, number] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(arg.trim());
  if (!m) throw new Error(`--day-size takes N or LO-HI, not "${arg}"`);
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  if (lo < 1 || hi < lo) throw new Error(`--day-size ${arg}: needs 1 ≤ LO ≤ HI`);
  return [lo, hi];
}

/** `"1:1:8"` → hidden 1, control 1, neutral 8. */
export function parseMix(arg: string): UserOptions["mix"] {
  const parts = arg.split(":").map(Number);
  if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x) || x < 0) || parts.every((x) => x === 0)) {
    throw new Error(`--mix takes hidden:control:neutral shares, not "${arg}"`);
  }
  return { hidden: parts[0]!, control: parts[1]!, neutral: parts[2]! };
}

/**
 * How many of a day's `n` requests are hidden and control: each kind's share rounded, at least one of each when its
 * share is non-zero (a day of 12 at 1:1:8 has one hidden and one control request, a day of 20 two of each).
 */
export function dayKinds(n: number, mix: UserOptions["mix"]): { hidden: number; control: number; neutral: number } {
  const sum = mix.hidden + mix.control + mix.neutral;
  const take = (share: number) => (share > 0 ? Math.max(1, Math.round((n * share) / sum)) : 0);
  let hidden = take(mix.hidden);
  let control = take(mix.control);
  // Only when the day is too short for the minimums: never more planted requests than requests.
  while (hidden + control > n) {
    if (control >= hidden && control > 0) control--;
    else hidden--;
  }
  const neutral = mix.neutral > 0 ? n - hidden - control : 0;
  if (mix.neutral === 0) {
    // No neutral share: the rest split between the planted kinds, hidden first.
    const rest = n - hidden - control;
    hidden += mix.control > 0 ? Math.ceil(rest / 2) : rest;
    control += mix.control > 0 ? Math.floor(rest / 2) : 0;
  }
  return { hidden, control, neutral };
}

/**
 * A user's D days: per day a size in the range, its kinds by `dayKinds`, its requests drawn from the suites' templates
 * without replacement (a template appears once per user) and put in a random order. Deterministic per seed. Throws
 * when a neutral request falls on a suite without it.
 *
 * Weeks (P7, D874): when the templates run out before the last day, the plan is made by `planWeeks` instead, so every
 * plan that fits is exactly what it was before weeks existed.
 */
export function planUser(
  seed: number,
  templates: Record<string, readonly string[]>,
  options: UserOptions,
): UserPlanEntry[][] {
  const rng = new Rng(seed * 7_919 + 16_016);
  const all = Object.entries(templates).flatMap(([suite, names]) => names.map((template) => ({ suite, template })));
  const pool = rng.sample(all, Number.MAX_SAFE_INTEGER);
  const days: UserPlanEntry[][] = [];
  for (let d = 0; d < options.days; d++) {
    const n = rng.int(options.size[0], options.size[1]);
    if (pool.length < n) return planWeeks(seed, all, options);
    const k = dayKinds(n, options.mix);
    const drawn = pool.splice(0, n);
    const day: UserPlanEntry[] = drawn.map((t, i) => ({
      ...t,
      variant: i < k.hidden ? "hidden" : i < k.hidden + k.control ? "control" : "neutral",
    }));
    checkNeutral(day);
    days.push(rng.sample(day, day.length));
  }
  return days;
}

const checkNeutral = (day: readonly UserPlanEntry[]) => {
  for (const e of day) {
    if (e.variant === "neutral" && !supportsNeutral(e.suite)) {
      throw new Error(`${e.suite} builds no neutral variant (neutral.ts): a long horizon needs suites that do`);
    }
  }
};

/**
 * A plan longer than the templates (D874). A user's world holds every planted item from the start, so a template
 * planted for the user must never also be asked as a neutral request (its fact or decoy would be in that request's
 * world, and a grader would count raising it as a false concern). So the planted slots of all days are drawn first,
 * without replacement, and the neutral requests cycle through the templates never planted for this user (reshuffled
 * each time round, never twice in one day). Throws when the planted slots need more templates than there are, or
 * none is left for the neutral requests. Its own random stream: a weeks plan shares nothing with the short one.
 */
export function planWeeks(
  seed: number,
  all: readonly { suite: string; template: string }[],
  options: UserOptions,
): UserPlanEntry[][] {
  const rng = new Rng(seed * 7_919 + 874);
  const sizes = Array.from({ length: options.days }, () => rng.int(options.size[0], options.size[1]));
  const kinds = sizes.map((n) => dayKinds(n, options.mix));
  const plantedSlots = kinds.reduce((x, k) => x + k.hidden + k.control, 0);
  const shuffled = rng.sample(all, Number.MAX_SAFE_INTEGER);
  if (plantedSlots > shuffled.length) {
    throw new Error(`--days ${options.days}: ${plantedSlots} planted requests need more templates than ${all.length}`);
  }
  const planted = shuffled.slice(0, plantedSlots);
  const neutralSet = shuffled.slice(plantedSlots);
  if (!neutralSet.length && kinds.some((k) => k.neutral > 0)) {
    throw new Error(`--days ${options.days}: no template is left for the neutral requests`);
  }
  let queue: { suite: string; template: string }[] = [];
  const days: UserPlanEntry[][] = [];
  for (const [d, k] of kinds.entries()) {
    const day: UserPlanEntry[] = [];
    for (let i = 0; i < k.hidden + k.control; i++) {
      day.push({ ...planted.shift()!, variant: i < k.hidden ? "hidden" : "control" });
    }
    const today = new Set<string>();
    for (let i = 0; i < k.neutral; i++) {
      if (today.size >= neutralSet.length) throw new Error(`--days: day ${d} has more neutral requests than templates`);
      // Next in the cycle not yet asked today; a new round reshuffles the never-planted templates.
      let at = queue.findIndex((t) => !today.has(`${t.suite}|${t.template}`));
      while (at < 0) {
        queue = [...queue, ...rng.sample(neutralSet, Number.MAX_SAFE_INTEGER)];
        at = queue.findIndex((t) => !today.has(`${t.suite}|${t.template}`));
      }
      const [t] = queue.splice(at, 1);
      today.add(`${t!.suite}|${t!.template}`);
      day.push({ ...t!, variant: "neutral" });
    }
    checkNeutral(day);
    days.push(rng.sample(day, day.length));
  }
  return days;
}

/** Each suite's template names, in order (from a scratch world of the seed). */
export function suiteTemplates(seed: number, suites: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(
    suites.map((s) => [s, SUITES[s]!(preparedWorld(s, seed), seed, "hidden").map((t) => t.template)]),
  );
}

export interface UserWorld {
  seed: number;
  world: World;
  /** Every request in day order. */
  tasks: Task[];
  /** Requests per day, in order (sums to tasks.length). */
  daySizes: number[];
  /** Planted items another request's calendar-slot clearing would have removed (kept; counted for the header). */
  clashes: number;
}

/**
 * The user's world: the seed's base world, each hidden request's planted item and each control request's decoy (as
 * the suite plants them, with a ref of the combined world so two suites' items cannot share an id), dressed and with
 * every request's calendar slot cleared as worldOf does (keeping every planted item). Neutral requests plant nothing.
 * Tasks keep the suites' ids, kinds and grading (`must`), so the reports read them as the short horizon's.
 */
export function userWorldOf(seed: number, plan: readonly (readonly UserPlanEntry[])[]): UserWorld {
  const world = buildWorld({ seed: seed * 1_000 });
  const secrets = world.items.filter((i) => i.secret).map((i) => i.secret!);
  const suites = [...new Set(plan.flat().map((e) => e.suite))];
  // heldout20 lives at its own present (D1080): beside another suite, one of the two would read the wrong "today".
  if (suites.includes("heldout20") && suites.length > 1)
    throw new Error("heldout20 has its own world time: plan its users on it alone, not with other suites");
  // The suites' own connectors and filler (rare-sources.ts) are part of the user's base world, in every variant.
  for (const suite of suites) prepareWorld(suite, world, seed);
  // Each suite planted once per variant in a scratch copy of the base world: a task and its item by template.
  type Planted = { task: { id: string; text: string; detail: string; slotText?: string }; item?: WorldItem };
  const made = new Map<string, Planted>();
  for (const suite of suites) {
    for (const variant of ["hidden", "control", "neutral"] as const) {
      if (variant === "neutral" && !supportsNeutral(suite)) continue;
      const scratch: World = { ...world, items: [...world.items] };
      const before = scratch.items.length;
      const tasks = SUITES[suite]!(scratch, seed, variant);
      // A synth suite also writes its background and neutral items over base noise items in place (D884): carry
      // those into the user's world (the same items for every variant of a seed). Other suites only append.
      if (suite.startsWith("synth"))
        for (let k = 0; k < before; k++) if (scratch.items[k] !== world.items[k]) world.items[k] = scratch.items[k]!;
      const items = scratch.items.slice(before);
      tasks.forEach((t, i) => made.set(`${suite}|${t.template}|${variant}`, { task: t, item: items[i] }));
    }
  }
  const keep = new Set<string>();
  const tasks: Task[] = [];
  /** Ids seen: a template that returns as a request in a weeks-long plan (D874) gets `#2`, `#3`, … on its id. */
  const seen = new Map<string, number>();
  /** A reworded request's original text, whose slot is cleared (D871). */
  const slotOf = new Map<string, string>();
  for (const entry of plan.flat()) {
    const p = made.get(`${entry.suite}|${entry.template}|${entry.variant}`);
    if (!p) throw new Error(`${entry.suite} has no ${entry.variant} task ${entry.template}`);
    let planted: string | undefined;
    if (entry.variant !== "neutral" && p.item) {
      // A ref unique in the combined world, of the shape the train suites use (it names no template, since the tools
      // arm sees refs).
      const ref = `${p.item.kind}-${world.items.length}`;
      const item: WorldItem = { ...p.item, id: itemId(p.item.sourceId, ref), ref };
      world.items.push(item);
      dress(world, item);
      keep.add(item.id);
      planted = item.id;
    }
    const times = (seen.get(p.task.id) ?? 0) + 1;
    seen.set(p.task.id, times);
    const id = times === 1 ? p.task.id : `${p.task.id}#${times}`;
    if (p.task.slotText) slotOf.set(id, p.task.slotText);
    tasks.push({
      id,
      suite: entry.suite,
      kind: entry.variant,
      type: entry.template,
      event: "user_message",
      text: p.task.text,
      must: [{ id: entry.template, detail: p.task.detail }],
      secrets,
      ...(planted ? { planted } : {}),
    });
  }
  // Clashes: a planted item in another request's slot (clearSlot with only that request's own item kept).
  let clashes = 0;
  for (const t of tasks) {
    const probe: World = { ...world, items: [...world.items] };
    clearSlot(probe, slotOf.get(t.id) ?? t.text, new Set(t.planted ? [t.planted] : []));
    const left = new Set(probe.items.map((i) => i.id));
    for (const id of keep) if (id !== t.planted && !left.has(id)) clashes++;
  }
  for (const t of tasks) clearSlot(world, slotOf.get(t.id) ?? t.text, keep);
  return { seed, world, tasks, daySizes: plan.map((d) => d.length), clashes };
}

/**
 * The tasks with a recap turn after each day (pi-day.ts's recap), the days given by size; the day's Eden session and
 * the recap's id are `<prefix>:day<d>` and `<prefix>:day<d>:recap`.
 */
export function withDayRecaps(tasks: readonly Task[], sizes: readonly number[], recap: (t: Task, d: number) => Task) {
  const out: Task[] = [];
  let i = 0;
  sizes.forEach((n, d) => {
    const day = tasks.slice(i, i + n);
    i += n;
    if (!day.length) return;
    out.push(...day, recap(day[day.length - 1]!, d));
  });
  return out;
}

/** The day each task of a user run falls on (by id), from the day sizes. */
export function dayOf(tasks: readonly Pick<Task, "id">[], sizes: readonly number[]): Map<string, number> {
  const out = new Map<string, number>();
  let i = 0;
  sizes.forEach((n, d) => {
    for (const t of tasks.slice(i, i + n)) out.set(t.id, d);
    i += n;
  });
  return out;
}
