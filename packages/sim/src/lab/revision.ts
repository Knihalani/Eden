/**
 * M3b (D914): `+revision` for the hand-written suites. A hidden task's planted fact stays as it is, the current
 * version; beside it goes a stale earlier version of it as a separate item: the same source, kind and title, dated
 * three days earlier, its text with one detail changed by a fixed rule (`stale`), so the fact reads as a silent
 * correction of it. The rule is mechanical and applied to every template alike, so it is not tuned to any model.
 *
 * The stale copy takes the place of a noise item (of the fact's source when there is one), never appended: harnesses
 * line planted items up with tasks by `world.items.slice(before)`. It is dressed (`dress`) when planted, as the
 * harnesses dress planted items, and its id is the task's `stale`, which harnesses keep from `clearSlot` and report
 * (`staleHanded`). Control and neutral variants are the base suite's, unchanged.
 */
import { itemId } from "@eden/protocol";
import { Rng } from "../rng";
import type { World, WorldItem } from "../world";
import { dress, type HiddenTask } from "./hidden-context";

type Plant = (world: World, seed: number, variant: "hidden" | "control" | "neutral") => HiddenTask[];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DATE = new RegExp(String.raw`\b(?:(${DAYS.join("|")}),?\s+)?(\d{1,2})(st|nd|rd|th)?\s+(${MONTHS.join("|")})\b`);
// A clock time in the content: not a chat line's "[07:00]" stamp.
const TIME = /(?<!\[)\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\])/;
const MONEY = /([£$€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/;
// A day written as "05/11" (day first, as the sim's British worlds write it) or "the 12th".
const SLASH = /\b(\d{1,2})\/(\d{1,2})\b/;
const ORDINAL = /\bthe (\d{1,2})(st|nd|rd|th)\b/;
// A count standing alone (up to three digits): not part of an id, a reference or a year.
const NUMBER = /(?<![\w\-/.])([2-9]|[1-9]\d{1,2})(?![\w\-/])/;

/** Which rule changed the stale copy. */
export type StaleRule = "date" | "time" | "amount" | "number" | "draft";

/**
 * The stale earlier version of `text` (and of `title`, where the same detail is written there too): the first rule
 * that applies changes one detail, in a mail's body (its own header block aside). A written date ("Thursday 29
 * October") moves two days (back if it is after the 26th, else forward), its weekday with it, as does a "05/11" or "the
 * 12th" day; else a clock time moves an hour earlier; else an amount rises 25%; else a count standing alone rises by
 * one; else the text is marked as a draft. Returns the rule and the day shift (for an event's start).
 */
export function stale(title: string, text: string): { title: string; text: string; rule: StaleRule; days: number } {
  // A mail's own header block (From/To/Date) is not content: the rule reads and changes the body after it.
  const head = /^From: [^\n]*\n(?:[A-Za-z-]+: [^\n]*\n)*\n/.exec(text)?.[0] ?? "";
  const r = body(title, text.slice(head.length));
  return { ...r, text: head + r.text };
}

function body(title: string, text: string): { title: string; text: string; rule: StaleRule; days: number } {
  const all = (s: string, from: string, to: string) => s.split(from).join(to);
  let m = DATE.exec(text);
  if (m) {
    const day = Number(m[2]);
    const shift = day > 26 ? -2 : 2;
    const weekday = m[1] ? DAYS[(DAYS.indexOf(m[1]) + shift + 7) % 7]! : undefined;
    const to = `${weekday ? `${weekday} ` : ""}${day + shift}${m[3] ? suffix(day + shift) : ""} ${m[4]}`;
    return { title: all(title, m[0], to), text: all(text, m[0], to), rule: "date", days: shift };
  }
  m = SLASH.exec(text);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31 && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const day = Number(m[1]);
    const shift = day > 26 ? -2 : 2;
    const to = `${String(day + shift).padStart(m[1]!.length, "0")}/${m[2]}`;
    return { title: all(title, m[0], to), text: all(text, m[0], to), rule: "date", days: shift };
  }
  m = ORDINAL.exec(text);
  if (m) {
    const day = Number(m[1]);
    const shift = day > 26 ? -2 : 2;
    const to = `the ${day + shift}${suffix(day + shift)}`;
    return { title: all(title, m[0], to), text: all(text, m[0], to), rule: "date", days: shift };
  }
  m = TIME.exec(text);
  if (m && Number(m[1]) >= 1) {
    const to = `${String(Number(m[1]) - 1).padStart(m[1]!.length, "0")}:${m[2]}`;
    return { title: all(title, m[0], to), text: all(text, m[0], to), rule: "time", days: 0 };
  }
  m = MONEY.exec(text);
  if (m) {
    const raw = m[2]!.replace(/,/g, "");
    const decimals = raw.includes(".") ? raw.split(".")[1]!.length : 0;
    const value = (Number(raw) * 1.25).toFixed(decimals);
    const grouped = m[2]!.includes(",")
      ? Number(value).toLocaleString("en-GB", { minimumFractionDigits: decimals })
      : value;
    const to = `${m[1]}${m[0].includes(" ") ? " " : ""}${grouped}`;
    return { title: all(title, m[0], to), text: all(text, m[0], to), rule: "amount", days: 0 };
  }
  m = NUMBER.exec(text);
  if (m) {
    const to = String(Number(m[1]) + 1);
    const at = m.index;
    return { title, text: text.slice(0, at) + to + text.slice(at + m[0].length), rule: "number", days: 0 };
  }
  return { title, text: `Draft: ${text}`, rule: "draft", days: 0 };
}

/** A mail header's date, as `dress` writes it. */
const mailDate = (at: number) =>
  new Date(at)
    .toUTCString()
    .replace(":00 GMT", "")
    .replace(/^(\w+),/, "$1,");

function suffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

/** Counts of the rule each stale copy was made by, over every `withRevision` planting in this process. */
export const STALE_RULES: Record<StaleRule, number> = { date: 0, time: 0, amount: 0, number: 0, draft: 0 };

/** `<suite>+revision`: the base suite with each hidden task's stale earlier version planted beside its fact. */
export function withRevision(name: string, plant: Plant): Plant {
  return (world, seed, variant) => {
    const before = world.items.length;
    const tasks = plant(world, seed, variant);
    if (variant !== "hidden") return tasks;
    const planted = world.items.slice(before);
    if (planted.length !== tasks.length) throw new Error(`${name}: ${tasks.length} tasks but ${planted.length} items`);
    const rng = new Rng(seed * 6_151 + 17);
    const taken = new Set<number>();
    const noiseOf = (source: string) =>
      world.items
        .map((it, i) => (i < before && it.noise && !it.secret && !taken.has(i) && it.sourceId === source ? i : -1))
        .filter((i) => i >= 0);
    return tasks.map((t, k) => {
      const fact = planted[k]!;
      const s = stale(fact.title, fact.text);
      STALE_RULES[s.rule]++;
      const ref = `${fact.ref}-earlier`;
      const meta = fact.meta?.start
        ? { ...fact.meta, start: new Date(Date.parse(fact.meta.start) + s.days * 86_400_000).toISOString() }
        : fact.meta;
      const item: WorldItem = {
        ...fact,
        id: itemId(fact.sourceId, ref),
        ref,
        title: s.title,
        text: s.text,
        updatedAt: fact.updatedAt - 3 * 86_400_000,
        facts: [],
        noise: false,
        ...(meta ? { meta } : {}),
      };
      dress(world, item);
      // Its own (earlier) date in a header the fact's text carried.
      item.text = item.text.replace(
        /^(From: [^\n]*\n(?:[A-Za-z-]+: [^\n]*\n)*?)Date: [^\n]*\n/,
        `$1Date: ${mailDate(item.updatedAt)}\n`,
      );
      let pool = noiseOf(fact.sourceId);
      if (pool.length === 0) pool = world.items.map((_, i) => i).filter((i) => i < before && world.items[i]!.noise);
      if (pool.length === 0) throw new Error(`${name}: no noise item left for ${t.template}'s stale version`);
      const at = pool[rng.int(0, pool.length - 1)]!;
      taken.add(at);
      world.items[at] = item;
      return { ...t, stale: item.id };
    });
  };
}
