/**
 * `packetChanges` (F3, trial): what changed in an item at its source since Eden first held it, kept per user so a
 * packet can say "changed at its source on Thu 12 Nov: was '11:00–15:00', now '14:00–17:30'" when it hands the item
 * over. The H19 diagnosis: 11 of the 16 facts that reached the agent unraised were items edited silently at their
 * source, and the packet showed only the version as it now reads.
 *
 * Only a synced copy replacing a synced copy counts (`ItemCache.onRevised`): a lookup's snippet replacing a listing's
 * whole text is no edit. What is kept is the change itself, not the old item: the words that differ between the two
 * versions (a common head and tail of words cut off), each side at most `SIDE_CHARS`, read from the cached copies,
 * which `sanitizeForStore` has already redacted (D10). In memory only (D8), keyed by tenant and user (D9), at most
 * `PER_USER` items a user and `MAX_USERS` users (least recently changed out first); an item leaving the cache takes
 * its change along, and `forget` drops the user's. A restart forgets every change (it is not persisted).
 */
import type { ContextItem, Scope } from "@eden/protocol";

/** One side of a change is at most this many characters (cut at a word, "…" added). */
export const SIDE_CHARS = 90;
const PER_USER = 64;
const MAX_USERS = 4_096;
/** Text read from each version: a change past it is not seen. */
const READ_CHARS = 4_000;

/** What changed in an item: the words it had and the words it has, and when Eden saw it change (engine clock, ms). */
export interface Change {
  was: string;
  now: string;
  at: number;
}

const userKey = (s: Scope) => `${s.tenantId}\u0000${s.userId}`;

/** A mail's own header block (From, To, Date…): when it was sent changes with every copy and is no edit of it. */
const HEADER = /^(?:From|To|Cc|Date|Sent|Subject|Reply-To): [^\n]*\n/gim;
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const bodyOf = (item: ContextItem) => words(item.text.slice(0, READ_CHARS).replace(HEADER, " "));

/** Words cut to `SIDE_CHARS` at a word boundary. */
function side(ws: readonly string[]): string {
  let out = "";
  for (const w of ws) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > SIDE_CHARS) return out ? `${out}…` : `${w.slice(0, SIDE_CHARS)}…`;
    out = next;
  }
  return out;
}

/**
 * The words two versions differ by: the common head and tail of words cut off, in the body (a mail's header lines
 * aside) or else the title. Null when they have the same words (only spacing changed), or when one is the other cut
 * short (a snippet and its whole text are no edit).
 */
export function changeOf(before: ContextItem, after: ContextItem): { was: string; now: string } | null {
  // The body first (what an edit usually changes), else the title.
  return differ(bodyOf(before), bodyOf(after)) ?? differ(words(before.title), words(after.title));
}

/** Words read past the first difference to find where the versions agree again. */
const RESYNC_WORDS = 120;
/** Words in a row the versions must share again for the change to end there. */
const ANCHOR = 3;

/**
 * The words two lists differ by: from the first word they differ at to where they next agree for `ANCHOR` words in a
 * row (else to the end of each). Null when they agree throughout, or when one is the other cut short (a snippet).
 */
function differ(a: readonly string[], b: readonly string[]): { was: string; now: string } | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  if (head === a.length && head === b.length) return null;
  // A copy cut short (its last word ends "…", or it simply stops) is the same item read in part.
  const short = (xs: readonly string[], ys: readonly string[]) =>
    head === xs.length ||
    (head === xs.length - 1 && xs[head]!.endsWith("…") && ys[head]?.startsWith(xs[head]!.slice(0, -1)));
  if (short(a, b) || short(b, a)) return null;
  const same = (i: number, j: number) => {
    for (let k = 0; k < ANCHOR; k++) if (a[i + k] === undefined || a[i + k] !== b[j + k]) return false;
    return true;
  };
  // The nearest point (fewest words skipped on both sides) where they agree again.
  let end: [number, number] = [a.length, b.length];
  const ai = Math.min(a.length, head + RESYNC_WORDS);
  const bj = Math.min(b.length, head + RESYNC_WORDS);
  let best = Infinity;
  for (let i = head; i < ai; i++) {
    if (i - head >= best) break;
    for (let j = head; j < bj && i - head + (j - head) < best; j++) {
      if (same(i, j)) {
        best = i - head + (j - head);
        end = [i, j];
      }
    }
  }
  // A short change ("3" to "1") is said with a shared word either side, so it reads ("by 3 Nov" to "by 1 Nov").
  const from = end[0] - head <= 2 && end[1] - head <= 2 && head > 0 ? head - 1 : head;
  const more = end[0] - head <= 2 && end[1] - head <= 2 && end[0] < a.length ? 1 : 0;
  return { was: side(a.slice(from, end[0] + more)), now: side(b.slice(from, end[1] + more)) };
}

export class Versions {
  private readonly users = new Map<string, Map<string, Change>>();

  /** Notes that `after` replaced `before` at `at`, when their words differ. */
  note(scope: Scope, before: ContextItem, after: ContextItem, at: number): void {
    const change = changeOf(before, after);
    if (!change) return;
    const key = userKey(scope);
    let mine = this.users.get(key);
    if (mine) this.users.delete(key);
    else mine = new Map();
    this.users.set(key, mine); // Most recently changed last.
    while (this.users.size > MAX_USERS) this.users.delete(this.users.keys().next().value as string);
    mine.delete(after.id);
    mine.set(after.id, { ...change, at });
    while (mine.size > PER_USER) mine.delete(mine.keys().next().value as string);
  }

  /** The item's last change, if Eden saw one and still holds the item. */
  get(scope: Scope, id: string): Change | undefined {
    return this.users.get(userKey(scope))?.get(id);
  }

  /** Items leaving the cache take their changes along; null drops the whole user. */
  drop(scope: Scope, ids: readonly string[] | null): void {
    const key = userKey(scope);
    if (ids === null) {
      this.users.delete(key);
      return;
    }
    const mine = this.users.get(key);
    if (!mine) return;
    for (const id of ids) mine.delete(id);
    if (mine.size === 0) this.users.delete(key);
  }

  /** Users with a change held (tests and metrics). */
  get userCount(): number {
    return this.users.size;
  }
}
