/**
 * Supersession (`supersede`, docs/research/smart-supersede.md): what the user's items say now, not what they once
 * said. A matter is written about more than once (a hold, then the hold lifted; a booking, then the booking moved), and
 * the agent that reads the older statement without the newer one raises a concern that no longer stands, or misses
 * the one that does.
 *
 * - Across items: items about the same matter (the same subject once "Re:"/"Fwd:" are stripped, or the same
 *   identifier such as a ticket's "OPS-142") form a group; ordered by when each was written, an item is superseded
 *   when a newer one in its group says something decisive about the request (`conflict.ts`: a conflict or a clearance,
 *   which covers lifted, extended, moved and cancelled). Only the newest decisive state is surfaced.
 * - Within a thread: a reply quotes the messages before it under it, newest first. `chronological` puts them oldest
 *   first, so a statement's "later" is its real later (`assess` lets a clearance after a block win, and a block after
 *   a clearance stand).
 *
 * No model, no call: items are grouped by their titles and identifiers, read once per candidate.
 */
import type { ContextItem } from "@eden/protocol";
import { sentAt } from "./conflict";

/** Reply and forward prefixes a mail client puts before a subject, any number deep ("Re: Fwd: RE:"). */
const PREFIXES = /^(?:\s*(?:re|fwd?|aw|wg|tr|sv|vs|antw)\s*(?:\[\d+\])?\s*:\s*)+/i;
/** An identifier a ticket, invoice or order goes by: letters, a hyphen, digits ("OPS-142", "INV-5842"). */
const IDENT = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;
/** A title too generic to say two items are about one matter ("Hi", "Update", "Quick question"). */
const MIN_SUBJECT = 8;

/**
 * The matters an item is about, as keys: its subject without reply prefixes (mail and chat titles are subjects), and
 * each identifier its title names. An item with neither is in no group and is never superseded.
 */
export function matterKeys(item: ContextItem): string[] {
  const keys: string[] = [];
  const subject = item.title.replace(PREFIXES, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (subject.length >= MIN_SUBJECT) keys.push(`s:${item.sourceId}:${subject}`);
  for (const m of item.title.matchAll(IDENT)) keys.push(`id:${m[0].toLowerCase()}`);
  return keys;
}

/** When an item was written: its message date, else when its source last changed it. */
function writtenAt(item: ContextItem): number | null {
  return sentAt(item) ?? item.updatedAt ?? null;
}

/**
 * The items superseded by a newer item about the same matter, each with the item and time that supersede it.
 * `decisive` says whether an item states something about the request (a conflict or a clearance): only such a newer
 * item supersedes, so a "thanks, will do" reply does not hide the notice it answers. Items with no time are left
 * alone. Linear in the items and their keys.
 */
export function supersededIn(
  items: readonly ContextItem[],
  decisive: (item: ContextItem) => boolean,
): Map<string, { by: string; at: number }> {
  const groups = new Map<string, { item: ContextItem; at: number }[]>();
  for (const item of items) {
    const at = writtenAt(item);
    if (at === null) continue;
    for (const k of matterKeys(item)) {
      const g = groups.get(k);
      if (g) g.push({ item, at });
      else groups.set(k, [{ item, at }]);
    }
  }
  const out = new Map<string, { by: string; at: number }>();
  const known = new Map<string, boolean>();
  const isDecisive = (item: ContextItem) => {
    let d = known.get(item.id);
    if (d === undefined) known.set(item.id, (d = decisive(item)));
    return d;
  };
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => b.at - a.at);
    const newest = g.find((x) => isDecisive(x.item));
    if (!newest) continue;
    for (const x of g) {
      if (x.at >= newest.at || x.item.id === newest.item.id) continue;
      const had = out.get(x.item.id);
      if (!had || had.at < newest.at) out.set(x.item.id, { by: newest.item.id, at: newest.at });
    }
  }
  return out;
}

/** A line's quote depth: how many ">" open it. */
function depthOf(line: string): number {
  let d = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === ">") d++;
    else if (c !== " ") break;
    i++;
  }
  return d;
}

/** "On Wed, 14 Oct 2026 10:00, Owen Price <…> wrote:": the line that opens a quoted message. */
const WROTE = /\bwrote:\s*$/i;

/**
 * A reply's text with its quoted messages oldest first: each run of lines at one quote depth is a message (the line
 * that introduces the next quote stays with the message it closes), and deeper is older. Quote marks are removed.
 * Text with no quoted line is returned as it is.
 */
export function chronological(text: string): string {
  if (!/^\s*>/m.test(text)) return text;
  const parts: { depth: number; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const depth = depthOf(raw);
    const line = raw.replace(/^[\s>]*/, "");
    const last = parts[parts.length - 1];
    if (last && last.depth === depth) last.lines.push(line);
    else if (!last && depth === 0) parts.push({ depth, lines: [line] });
    else if (last && line === "") last.lines.push(line);
    else parts.push({ depth, lines: [line] });
  }
  // The "… wrote:" line belongs to no message's words: dropped.
  const ordered = [...parts]
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => b.depth - a.depth || a.i - b.i)
    .map((p) => p.lines.filter((l) => !WROTE.test(l)).join("\n"));
  return ordered.join("\n\n");
}
