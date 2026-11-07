/**
 * `pi-ab --day K` (fix-s3b, docs/research/realuse-1-weak-points.md issue 12): one agent session across a simulated
 * day instead of one session per request. A stream's tasks are cut into days of K requests in template order; the
 * agent keeps its transcript (and the packets Eden gave it, where they were) from one request to the next, Eden sees
 * one session per day, and the day ends with a recap turn ("anything to watch out for, with the times").
 *
 * The world changes once a day, before the recap: every clock time in the day's planted items moves (`shiftClocks`,
 * and `shiftMeta` for a calendar item's structured start), the sources serve the new text and, with `--push` on,
 * signal the change, as plans moved during the day would. Only then, because the recap is never graded: a moved item
 * could land in a later request's slot and change that request's grade. The recap then shows whether Eden and the
 * agent carry the new version or the old one they saw earlier that day.
 *
 * Caveats: a changed item's content hash changes, so it misses the `--cards` and `--intent` replay files and is
 * carded live (booked to background spend) or left without requests; `lateItems` is not measured (a packet that
 * arrives after an answer is given at the next request of the day, as an agent loop would).
 *
 * `DayLog` measures, per day:
 * - repeat deliveries: an item a packet delivered that a packet of an earlier turn that day already delivered, and of
 *   those, the ones whose item changed in between (a revised copy, which may be worth sending again);
 * - "shown before" handling: packets and ask answers carrying the engine's `(shown above)` marker (`askDedup`), and
 *   asks citing an item a packet already delivered that day;
 * - stale facts: a packet or answer citing a changed item whose text still holds an old time and not its new one
 *   (approximate: the text check is over the whole packet), and the recap answer naming a changed item's old time
 *   without its new one (`staleRecap`) or its new one (`freshRecap`).
 */
import type { Task } from "./ab-common";

/** The engine's marker for an item already shown in the session (render.ts `SHOWN`, askDedup). */
export const SHOWN_MARK = "(shown above)";

/** How an "updated:" packet names each item (partner.ts, `revisionNotice`). */
export const UPDATED_MARK = "] updated: ";

/** The day's last turn: not a task (never graded, not in the results), only measured. */
export const RECAP_TEXT =
  "Before I act on today's plans: give me a short recap of anything I should watch out for across everything we " +
  "discussed today, with the specific times.";

const CLOCK = /\b([01]\d|2[0-3]):([0-5]\d)\b/g;

export interface ClockMove {
  from: string;
  to: string;
}

/**
 * Every distinct clock time in `text` moved `hours` later (mod 24), all in one pass so a moved time is never moved
 * again; a move landing on another time already in the text is pushed one more hour, so old and new stay apart.
 */
export function shiftClocks(text: string, hours = 2): { text: string; moves: ClockMove[] } {
  const found = [...new Set([...text.matchAll(CLOCK)].map((m) => m[0]))];
  const taken = new Set(found);
  const map = new Map<string, string>();
  for (const from of found) {
    const [h, m] = from.split(":").map(Number) as [number, number];
    let k = hours;
    let to = "";
    for (; k < hours + 24; k++) {
      to = `${String((h + k) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      if (!taken.has(to)) break;
    }
    taken.add(to);
    map.set(from, to);
  }
  return {
    text: text.replace(CLOCK, (x) => map.get(x) ?? x),
    moves: found.map((from) => ({ from, to: map.get(from)! })),
  };
}

/**
 * A structured start or end (`meta.start`, `meta.end`: ISO instants) moved as the text's clock time it shows (its
 * UTC hour and minute) moved, so a calendar item's text and its structure agree after a change.
 */
export function shiftMeta(meta: Record<string, string>, moves: readonly ClockMove[]): Record<string, string> {
  const out = { ...meta };
  for (const key of ["start", "end"]) {
    const v = out[key];
    const t = v ? Date.parse(v) : NaN;
    if (!Number.isFinite(t)) continue;
    const hhmm = new Date(t).toISOString().slice(11, 16);
    const m = moves.find((x) => x.from === hhmm);
    if (!m) continue;
    const mins = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3));
    const delta = (((mins(m.to) - mins(m.from)) % 1_440) + 1_440) % 1_440;
    out[key] = new Date(t + delta * 60_000).toISOString();
  }
  return out;
}

/** The recap turn closing a day whose last task was `t`: never graded, planting nothing. */
export function recapOf(t: Task, id: string): Task {
  // A user's turn whatever the day's last task was (an arriving message would be observed as one otherwise).
  const out: Task = { ...t, id, text: RECAP_TEXT, must: [], type: "recap", event: "user_message" };
  delete (out as { planted?: string }).planted;
  return out;
}

/** The tasks of a stream with a recap turn after every `size` of them (and after the last). */
export function withRecaps(tasks: readonly Task[], size: number): Task[] {
  if (!(size > 0)) return [...tasks];
  const out: Task[] = [];
  tasks.forEach((t, i) => {
    out.push(t);
    if (i % size === size - 1 || i === tasks.length - 1) out.push(recapOf(t, recapId(t.id, Math.floor(i / size))));
  });
  return out;
}

/** `w41:heldout14:tmpl` → `w41:heldout14:day0` (the day's Eden session) and `…:day0:recap`. */
export const dayId = (taskId: string, day: number) => `${taskId.split(":").slice(0, 2).join(":")}:day${day}`;
export const recapId = (taskId: string, day: number) => `${dayId(taskId, day)}:recap`;
export const isRecap = (t: Pick<Task, "type">) => t.type === "recap";

export interface DaySummary {
  day: string;
  condition: string;
  turns: number;
  /** Items packets delivered (citations), and those a packet of an earlier turn that day had delivered already. */
  delivered: number;
  repeatDelivered: number;
  /** Of the repeats, items changed at the source since their earlier delivery. */
  repeatChanged: number;
  /** Packets and ask answers carrying `(shown above)`. */
  shownMarks: number;
  /** "updated:" packets (`revisionNotice`): an item handed earlier, sent again in its changed version. */
  updatePackets: number;
  /** Ask citations of items a packet had delivered earlier that day. */
  askRepeat: number;
  /** Items changed during the day (planted items with a clock time). */
  changed: number;
  /** Packets or answers after a change citing the changed item with only its old time. */
  staleDeliveries: number;
  /** Changed items the recap names with an old time and not the new / with a new time. */
  staleRecap: number;
  freshRecap: number;
  recapAnswered: boolean;
}

interface Delivery {
  turn: number;
  ids: string[];
  text: string;
  ask: boolean;
}

export class DayLog {
  private turnNo = -1;
  private readonly deliveries: Delivery[] = [];
  /** item id → the turn after which it changed, and its moves (every change, if it moved more than once). */
  private readonly changes = new Map<string, { turn: number; moves: ClockMove[] }>();
  private recapText: string | null = null;

  constructor(
    readonly day: string,
    readonly condition: string,
  ) {}

  turn(): void {
    this.turnNo++;
  }

  packet(ids: readonly string[], text: string): void {
    this.deliveries.push({ turn: this.turnNo, ids: [...ids], text, ask: false });
  }

  answer(ids: readonly string[], text: string): void {
    this.deliveries.push({ turn: this.turnNo, ids: [...ids], text, ask: true });
  }

  /** The item changed at the start of the current turn, before anything that turn delivered. */
  changed(id: string, moves: readonly ClockMove[]): void {
    if (!moves.length) return;
    // A second change keeps the first one's moves too: an old time from either is stale.
    const before = this.changes.get(id);
    this.changes.set(id, { turn: this.turnNo, moves: [...(before?.moves ?? []), ...moves] });
  }

  recap(answer: string): void {
    this.recapText = answer;
  }

  summary(): DaySummary {
    let delivered = 0;
    let repeatDelivered = 0;
    let repeatChanged = 0;
    let shownMarks = 0;
    let updatePackets = 0;
    let askRepeat = 0;
    let staleDeliveries = 0;
    const firstPacket = new Map<string, number>();
    const oldOnly = (text: string, moves: readonly ClockMove[]) =>
      moves.some((m) => text.includes(m.from)) && !moves.some((m) => text.includes(m.to));
    for (const d of this.deliveries) {
      if (d.text.includes(SHOWN_MARK)) shownMarks++;
      if (!d.ask && d.text.includes(UPDATED_MARK)) updatePackets++;
      for (const id of d.ids) {
        const change = this.changes.get(id);
        if (change && d.turn >= change.turn && oldOnly(d.text, change.moves)) staleDeliveries++;
        const earlier = firstPacket.get(id);
        if (d.ask) {
          if (earlier !== undefined && earlier < d.turn) askRepeat++;
          continue;
        }
        delivered++;
        if (earlier !== undefined && earlier < d.turn) {
          repeatDelivered++;
          if (change && change.turn > earlier && change.turn <= d.turn) repeatChanged++;
        }
      }
      if (!d.ask) for (const id of d.ids) if (!firstPacket.has(id)) firstPacket.set(id, d.turn);
    }
    let staleRecap = 0;
    let freshRecap = 0;
    const recap = this.recapText ?? "";
    for (const { moves } of this.changes.values()) {
      if (moves.some((m) => recap.includes(m.to))) freshRecap++;
      else if (moves.some((m) => recap.includes(m.from))) staleRecap++;
    }
    return {
      day: this.day,
      condition: this.condition,
      turns: this.turnNo + 1,
      delivered,
      repeatDelivered,
      repeatChanged,
      shownMarks,
      updatePackets,
      askRepeat,
      changed: this.changes.size,
      staleDeliveries,
      staleRecap,
      freshRecap,
      recapAnswered: this.recapText !== null && this.recapText.trim() !== "",
    };
  }
}

/** Day summaries pooled per condition (sums; rates are the reader's to take). */
export function poolDays(days: readonly DaySummary[]): Record<string, Omit<DaySummary, "day" | "condition">> {
  const out: Record<string, Omit<DaySummary, "day" | "condition">> = {};
  for (const d of days) {
    const p = (out[d.condition] ??= {
      turns: 0,
      delivered: 0,
      repeatDelivered: 0,
      repeatChanged: 0,
      shownMarks: 0,
      updatePackets: 0,
      askRepeat: 0,
      changed: 0,
      staleDeliveries: 0,
      staleRecap: 0,
      freshRecap: 0,
      recapAnswered: true,
    });
    for (const k of Object.keys(p) as (keyof typeof p)[]) {
      if (k === "recapAnswered") p.recapAnswered = p.recapAnswered && d.recapAnswered;
      else p[k] += d[k];
    }
  }
  return out;
}

/**
 * Earlier turns' packets placed back where the agent saw them: before the k-th user turn, the packets of turn k;
 * the current turn's packets before the last user turn (as a single turn places them).
 */
export function placePackets<M extends { role: string }>(
  messages: readonly M[],
  earlier: readonly (readonly string[])[],
  current: readonly string[],
  asSystem: (text: string) => M,
): M[] {
  const users = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const lastUser = users.at(-1);
  const out: M[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") {
      const k = users.indexOf(i);
      const these = i === lastUser ? current : (earlier[k] ?? []);
      for (const t of these) out.push(asSystem(t));
    }
    out.push(m);
  });
  return out;
}
