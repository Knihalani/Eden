/**
 * D8's citations and D31's re-checks (P3.4): what the repo's files last said of each `(scope, slot)`, kept in the
 * store's `citations.json`, and how a new reading of those files changes the store by key (A4 §3.1–3.2).
 *
 * - **A new or changed value** (the files say what they did not say at the last reading): A4 §3.2's write table. The
 *   value visible at the fact's own scope equal → no row, the value is now cited; none, or a value the files gave
 *   (a cited row) → a cited row (`src:tool`, `cite`), which supersedes the old value at its scope and makes text
 *   carrying it `stale_for` (D31); a value the user typed → it stays, unless the user typed it before the files'
 *   last reading, which still said the old value (A4 §3.1: "a user statement beats a tool citation"; D8: "a later
 *   user statement overrides it", so a later change of the files overrides an earlier statement).
 * - **The same value** → only the reading's time and files are kept.
 * - **No value** (the file is gone, or no longer says it): a failed citation, which invalidates the fact (D31): the
 *   cited row, and a typed row the files confirmed at their last reading, go to history with no successor.
 *
 * The files are read at sleep's heavy tier (D34), for the whole repo, and when Claude Code's FileChanged fires on a
 * cited file (D31), for the folders citing it. SessionStart, CwdChanged and FileChanged return the cited files as
 * `watchPaths` (R0 F29: absolute, ≤ 200, newest-cited first, each return replacing the list).
 */
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { withFileLock, writeFileAtomic } from "../packages/cli/src/home";
import type { AgentMemory, MemoryRecord } from "./index";
import { memoryNow } from "./memory-clock";
import { isCited, isUntyped } from "./memory-provenance";
import { minedText, type MinedFact } from "./memory-repo-facts";
import { noteSlots, SLOT_IDS, type SlotId } from "./memory-slots";

/** What the files said of one `(scope, slot)` at their last reading (`checked`), and which files said it. */
export interface Citation {
  scope: string;
  slot: SlotId;
  value: string;
  files: string[];
  checked: number;
}

const FILE = "citations.json";
/** R0 F29 / D31: at most this many paths to watch. */
export const WATCH_LIMIT = 200;

function keyOf(fact: { scope: string; slot: SlotId }): string {
  return `${fact.scope}\0${fact.slot}`;
}

function isCitation(value: unknown): value is Citation {
  const c = value as Partial<Citation> | null;
  return (
    !!c &&
    typeof c.scope === "string" &&
    typeof c.value === "string" &&
    typeof c.checked === "number" &&
    SLOT_IDS.includes(c.slot as SlotId) &&
    Array.isArray(c.files) &&
    c.files.every((file) => typeof file === "string")
  );
}

/** A store's citations; none when it has none, or a file this code cannot read. */
export function readCitations(store: string): Citation[] {
  try {
    const parsed = JSON.parse(readFileSync(join(store, FILE), "utf8")) as { facts?: unknown };
    return Array.isArray(parsed.facts) ? parsed.facts.filter(isCitation) : [];
  } catch {
    return [];
  }
}

/** Whether a store has read its repo's files at least once. */
export function hasCitations(store: string): boolean {
  try {
    readFileSync(join(store, FILE));
    return true;
  } catch {
    return false;
  }
}

/** The newest live row that keys a slot at exactly a scope: the value A4 §3.2 compares a new one with. */
function holderAt(rows: readonly MemoryRecord[], slot: SlotId, scope: string): MemoryRecord | undefined {
  return rows
    .filter((row) => (row.scope ?? "") === scope && (isCited(row) || !isUntyped(row)))
    .filter((row) => noteSlots(row).some((ref) => ref.k === slot && ref.v !== undefined))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || (b.id > a.id ? 1 : -1))[0];
}

function valueOf(row: MemoryRecord, slot: SlotId): string | undefined {
  return noteSlots(row).find((ref) => ref.k === slot && ref.v !== undefined)?.v;
}

/** What a reading of the files changes: rows to write, values whose citation failed, and the citations to keep. */
export interface CitationChanges {
  cite: MinedFact[];
  fail: Citation[];
  kept: Citation[];
}

/**
 * The changes a reading of some folders' files makes (see the header): `mined` is what those folders' files say
 * now, `folders` which folders were read (undefined: all of them, so a citation of a folder no longer read fails).
 */
export function citationChanges(
  known: readonly Citation[],
  mined: readonly MinedFact[],
  rows: readonly MemoryRecord[],
  now: number,
  folders?: readonly string[],
): CitationChanges {
  const read = (scope: string) => !folders || folders.includes(scope);
  const before = new Map(known.map((citation) => [keyOf(citation), citation]));
  const live = rows.filter((row) => row.invalidAt === undefined && row.invalidBy === undefined);
  const changes: CitationChanges = { cite: [], fail: [], kept: known.filter((citation) => !read(citation.scope)) };
  const minedKeys = new Set(mined.map(keyOf));
  for (const citation of known)
    if (read(citation.scope) && !minedKeys.has(keyOf(citation))) changes.fail.push(citation);
  for (const fact of mined) {
    const prev = before.get(keyOf(fact));
    changes.kept.push({ ...fact, checked: now });
    if (prev?.value === fact.value) continue;
    const holder = holderAt(live, fact.slot, fact.scope);
    if (holder && valueOf(holder, fact.slot) === fact.value) continue;
    const typedLater = holder && !isCited(holder) && (!prev || (holder.at ?? 0) > prev.checked);
    if (!typedLater) changes.cite.push(fact);
  }
  return changes;
}

/**
 * Applies a reading of some folders' files to a store (see the header and `citationChanges`), under the store's
 * citation lock. Returns the citations now kept. Fails open: a store it cannot lock keeps what it had.
 */
export function applyMined(
  mem: AgentMemory,
  mined: readonly MinedFact[],
  folders?: readonly string[],
  now = memoryNow(),
): Citation[] {
  try {
    return withFileLock(join(mem.dir, `${FILE}.lock`), () => {
      const changes = citationChanges(readCitations(mem.dir), mined, mem.memories(), now, folders);
      mem.endCitations(changes.fail);
      mem.citeFacts(changes.cite.map((fact) => ({ ...fact, text: minedText(fact) })));
      writeFileAtomic(join(mem.dir, FILE), `${JSON.stringify({ facts: changes.kept })}\n`, 0o600);
      return changes.kept;
    });
  } catch {
    return readCitations(mem.dir);
  }
}

/** The scopes whose citations name a file (repo-relative, `/`): the folders a FileChanged re-reads. */
export function scopesCiting(citations: readonly Citation[], rel: string): string[] {
  return [...new Set(citations.filter((citation) => citation.files.includes(rel)).map((citation) => citation.scope))];
}

/** A checkout file's path relative to its top, with `/`; undefined outside it. */
export function repoRelative(top: string, path: string): string | undefined {
  const rel = relative(top, path);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return undefined;
  return rel.split(sep).join("/");
}

/** D31's `watchPaths`: every cited file under `top`, absolute, newest-cited first, at most `WATCH_LIMIT`. */
export function watchPaths(citations: readonly Citation[], top: string): string[] {
  const files = [...citations]
    .sort((a, b) => b.checked - a.checked)
    .flatMap((citation) => citation.files.map((file) => join(top, ...file.split("/"))));
  return [...new Set(files)].slice(0, WATCH_LIMIT);
}
