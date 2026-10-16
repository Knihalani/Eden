/**
 * Place (A4 §2; D2, D4): the scopes a window is working in, its **read set**, and what a row stored or read there may
 * see. It is folded from the window's `ctx.log` (A4 §1) by the point that needs it, with the store's scope catalog
 * (`memory-scopes.ts`, D3).
 *
 * - **Paths, by D4's source.** A human Submit records the places of the repo its prompt names (`prompt`, never the
 *   prompt's text, X11), and reads them as they are; a subagent's prompt is its task, whose places its `scope.json`
 *   keeps (`memory-spawn.ts`).
 *   Each PostToolBatch records its tool paths and, apart, its Bash paths (`memory-batch.ts`), and a subagent's batch
 *   is recorded in its session's window too, as `sub` (D2).
 * - **Recent** is the last 3 human turns: what the window recorded from its third-newest `prompt` record on (all of
 *   it in a window with fewer, such as a subagent's), each source's 64 newest distinct paths. A Submit records its
 *   own prompt first, so its turn is one of the 3 (in read-only consent, which records nothing, it is not).
 * - **Weights (D4).** Each distinct path gains the weight of every source it is in: named in the current turn's
 *   prompt 3; a main-thread tool path of the most recent batch 2, of the last 3 human turns 1; a main-thread Bash path
 *   1. A scope holds its paths' weight. A subagent path weighs 0.5, and counts only when the main-thread paths carry
 *   < 30% of all the weight (D2's tie-breaker).
 * - **The read set** is every scope holding ≥ 30% of the weight, at most 2, heaviest first; of equal weights, the one
 *   met first, newest source first. When none reaches 30%, it is the scope owning the paths' common folder; with no
 *   path, `""`. A path of another repo, or outside git, is no place of this one.
 * - **Visibility (A4 §2).** A slot fact (a legacy fact too), a policy or an intent is visible at its scope and
 *   below it (D5's cascade; the override below); a gotcha, procedure or episode at its scope only, and from an
 *   ancestor only when the prompt names its scope; nothing at a sibling. A row with no `scope` was written where its
 *   place was unknown (before P3.2, or in a repo with no catalog, outside git included): it stays visible everywhere,
 *   as every row was, and a window in such a repo reads every row.
 * - **D5's override (P3.4 for mined facts, P3.5 for typed ones).** A slot fact is not delivered at a read-set folder
 *   below its scope where a folder between has its own live row of one of its slots, typed or mined, whatever its
 *   value: "We use node 20 across the repo" says nothing at apps/web once "apps/web runs node 22", nor at a turn
 *   reading apps/web and packages/cli, where a bullet naming no folder would be read as apps/web's (G2 outranks G1,
 *   A4 §0). A row stating two slots goes when either is overridden. A statement split by its slots' scopes keeps its
 *   whole text at each part (A4 §3.2), so where the other part's value does not hold, a part is said by its own keys
 *   alone: "we use pnpm and vitest", typed in apps/web, is "Package manager: pnpm" at the root and at packages/cli. A
 *   value ended at the row's own scope is validity's (D31), clause by clause.
 * - **A first touch (A4 §5.5).** The candidates of a PostToolBatch's first touch of a scope are that scope's own slot
 *   facts (`scopeFacts`).
 * - **A row's scope (A4 §3.2).** The one scope of the catalog its text names (the root's by a file path in its own
 *   folders, "scripts/db.ts"); of several, the working scope (the
 *   read set's first) when it is one of them, else their common ancestor; naming none, the working scope, or `""` for
 *   a rule (A4 §2: policies are mostly `""`) and for a fact of D7's root slots (`default_scope: root`, written at `""`
 *   unless the utterance names a scope; the caller decides which with the slot table, `memory-slots.ts`).
 * - **Two scopes (A4 §2, D4).** When the read set has two scopes and a candidate states a slot at one of them, the
 *   other scope's value for that slot joins it in one bullet: `auth provider — apps/web: Clerk · packages/cli: none`.
 *   A candidate stating one D7 slot (P3.3) takes the other value from the newest live row the user typed at the other
 *   scope that sets the same slot, else that states a sentence naming one of the slot's aliases ("has no auth"); the
 *   bullet is named by the slot's label. A fact of no D7 slot that the legacy copula reader parses keeps that
 *   reading, its subject's words standing for its aliases. Every other candidate at either scope is labelled with its
 *   scope unless its text names it.
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, posix, relative } from "node:path";
import {
  isCited,
  isUntyped,
  knownNoteSource,
  noteKindToken,
  stripPacketLabel,
  type ProvenanceNote,
} from "./memory-provenance";
import { legacySlot } from "./memory-residual";
import { realpathOrSelf } from "./memory-repo";
import { repoPathOf, scopeOfDir } from "./memory-scopes";
import {
  mayStateSlot,
  namesSlot,
  noteSlots,
  slotAliases,
  slotLabel,
  slotsIn,
  typedValue,
  type SlotId,
} from "./memory-slots";
import { subjectWords } from "./memory-validity";
import { STATUS_WORDS } from "./memory-transcript";
import { appendRecord, windowRecords } from "./memory-window";

/** D4's weights, by source. */
export const PLACE_WEIGHTS = { prompt: 3, batch: 2, turn: 1, bash: 1, subagent: 0.5 } as const;
/** D4: a scope joins the read set with this share of the weight… */
const READ_SHARE = 0.3;
/** …and the read set holds at most this many. */
const READ_MAX = 2;
/** D4's "last 3 human turns". */
const RECENT_TURNS = 3;
const CONTEXT = "ctx.log";
/** A record line stays under 4 KB (`memory-window.ts`): at most 8 paths of at most 200 characters. */
const MAX_PATHS = 8;
const MAX_PATH = 200;
/**
 * A source's newest distinct paths a place reads, at most: each costs a few filesystem calls (`repoPathOf`), and one
 * long turn can touch thousands.
 */
const MAX_RECENT_PATHS = 64;

/** The places a window's recent turns named and touched, by D4's source, newest first (see the header). */
export interface PlacePaths {
  prompt: string[];
  batch: string[];
  turns: string[];
  bash: string[];
  sub: string[];
}

/** Where a window is working: its read set, and the scopes its prompt names. */
export interface Place {
  readSet: string[];
  named: string[];
}

/**
 * The repo a window's paths are read against: its key, its checkout's top, its catalog's scopes, and the session's
 * folder relative to the top (`""` at the top), which a relative path in a text may be read from.
 */
export interface RepoScopes {
  repo: string;
  top: string;
  scopes: readonly string[];
  cwd?: string;
}

/** What splits a text into the tokens a path may be. */
const TOKEN_BREAK = /[\s,;()[\]{}<>"'`]+/;
const URL = /\b[a-z][\w+.-]*:\/\/\S*/gi;
const PATH_SHAPED = /^(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\/?$/;
const FILE_NAME = /^[\w.-]+\.[A-Za-z]\w{0,7}$/;

/** A path relative to the repo's top, if it is inside it; "" for the top itself. */
export function underTop(path: string, top: string): string | undefined {
  if (!isAbsolute(path)) return normalize(path).replace(/^\.\/+/, "");
  for (const base of new Set([top, realpathOrSelf(top)])) {
    const rel = relative(base, path);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  return undefined;
}

/**
 * A place of the repo: it exists under the top, or it is a file to create, one with a file name's shape in a folder
 * that exists ("apps/web/app/new.ts"); prose with a slash ("and/or", "client/server") is neither.
 */
function inRepo(rel: string, top: string): boolean {
  if (!rel || rel.startsWith("..")) return false;
  const path = join(top, rel);
  if (existsSync(path)) return true;
  return rel.includes("/") && FILE_NAME.test(basename(rel)) && existsSync(dirname(path));
}

/**
 * The places of the repo a text names, in order, each once, at most 8 (see the header): paths with a folder, and file
 * names, that are places of the repo under `top`, a relative one read from `cwd` first (a session in `apps/web` naming
 * `app/login.ts`). URLs are not places; absolute paths outside `top` are not the repo's.
 */
export function taskPaths(task: string, top: string, cwd = top): string[] {
  const out: string[] = [];
  for (const raw of String(task ?? "")
    .replace(URL, " ")
    .split(TOKEN_BREAK)) {
    const token = raw.replace(/[.:!?]+$/, "");
    if (!token || token.length > MAX_PATH || !(token.includes("/") ? PATH_SHAPED : FILE_NAME).test(token)) continue;
    const rel = repoPlace(token, top, cwd);
    if (rel && !out.includes(rel)) out.push(rel);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

/** A path as a place of the repo, relative to `top`: a relative one read from `cwd` first; none if it is no place. */
export function repoPlace(path: string, top: string, cwd = top): string | undefined {
  const reads = isAbsolute(path) ? [path] : [...new Set([join(cwd, path), path])];
  return reads
    .map((read) => underTop(read, top)?.replace(/\/+$/, ""))
    .find((candidate): candidate is string => !!candidate && inRepo(candidate, top));
}

const strings = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((item): item is string => typeof item === "string" && !!item) : [];

/** A record's paths: at most 8 distinct ones, of at most 200 characters (see `MAX_PATHS`). */
export function boundedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].slice(0, MAX_PATHS).map((path) => path.slice(0, MAX_PATH));
}

/** Appends a human prompt's places (see the header): the turn's mark, with or without places. */
export function recordPrompt(win: string, paths: readonly string[], promptId?: string): void {
  appendRecord(win, CONTEXT, { k: "prompt", paths: boundedPaths(paths), ...(promptId ? { prompt_id: promptId } : {}) });
}

/** Appends a subagent batch's paths to its session's window (D2). */
export function recordSubagentPaths(win: string, paths: readonly string[]): void {
  if (paths.length) appendRecord(win, CONTEXT, { k: "sub", paths: boundedPaths(paths) });
}

/**
 * A window's recent paths by source (see the header). `prompt` is the current prompt's places, when the caller has
 * them (a Submit's, a subagent's task); else the newest prompt record's.
 */
export function windowPaths(win: string, prompt?: readonly string[]): PlacePaths {
  const records = windowRecords(win, CONTEXT);
  const prompts = records.flatMap((record, at) => (record.k === "prompt" ? [at] : []));
  const recent = records.slice(prompts.length >= RECENT_TURNS ? prompts.at(-RECENT_TURNS) : 0).reverse();
  const batches = recent.filter((record) => record.k === "batch");
  const newest = recent.find((record) => record.k === "prompt");
  const newestOf = (paths: string[]) => [...new Set(paths)].slice(0, MAX_RECENT_PATHS);
  return {
    prompt: prompt ? [...prompt] : newest ? strings(newest.paths) : [],
    batch: batches.length ? strings(batches[0]!.paths) : [],
    turns: newestOf(batches.flatMap((batch) => strings(batch.paths))),
    bash: newestOf(batches.flatMap((batch) => strings(batch.bash))),
    sub: newestOf(recent.flatMap((record) => (record.k === "sub" ? strings(record.paths) : []))),
  };
}

/** Maps a recorded path (absolute, or relative to the repo's top) to the scope of this repo owning it. */
export function scopeMapper(at: RepoScopes): (path: string) => string | undefined {
  const seen = new Map<string, string | undefined>();
  return (path) => {
    if (seen.has(path)) return seen.get(path);
    const placed = repoPathOf(isAbsolute(path) ? path : join(at.top, path));
    const scope = placed && placed.repo === at.repo ? scopeOfDir(at.scopes, placed.rel) : undefined;
    seen.set(path, scope);
    return scope;
  };
}

/** Each scope's weight: the main thread's and the subagents', and the order scopes were met in (see the header). */
export interface ScopeWeights {
  main: Map<string, number>;
  sub: Map<string, number>;
  order: string[];
}

export function scopeWeights(paths: PlacePaths, scopeOf: (path: string) => string | undefined): ScopeWeights {
  const weights: ScopeWeights = { main: new Map(), sub: new Map(), order: [] };
  const add = (into: Map<string, number>, path: string, weight: number) => {
    const scope = scopeOf(path);
    if (scope === undefined) return;
    into.set(scope, (into.get(scope) ?? 0) + weight);
    if (!weights.order.includes(scope)) weights.order.push(scope);
  };
  const main: [readonly string[], number][] = [
    [paths.prompt, PLACE_WEIGHTS.prompt],
    [paths.batch, PLACE_WEIGHTS.batch],
    [paths.turns, PLACE_WEIGHTS.turn],
    [paths.bash, PLACE_WEIGHTS.bash],
  ];
  for (const [list, weight] of main) for (const path of new Set(list)) add(weights.main, path, weight);
  for (const path of new Set(paths.sub)) add(weights.sub, path, PLACE_WEIGHTS.subagent);
  return weights;
}

const total = (weights: ReadonlyMap<string, number>): number => [...weights.values()].reduce((a, b) => a + b, 0);

/** The read set (see the header); `ancestor` names the scope owning the common folder of scopes none of which won. */
export function readSetOf(weights: ScopeWeights, ancestor: (scopes: readonly string[]) => string): string[] {
  const main = total(weights.main);
  const sub = total(weights.sub);
  const all = new Map(weights.main);
  if (sub > 0 && main < READ_SHARE * (main + sub))
    for (const [scope, weight] of weights.sub) all.set(scope, (all.get(scope) ?? 0) + weight);
  const sum = total(all);
  if (!sum) return [""];
  const held = weights.order
    .filter((scope) => (all.get(scope) ?? 0) >= READ_SHARE * sum)
    .sort((a, b) => all.get(b)! - all.get(a)!)
    .slice(0, READ_MAX);
  return held.length ? held : [ancestor([...all.keys()])];
}

/** The scope of the catalog owning the deepest folder all of `scopes` are in. */
export function commonScope(scopes: readonly string[], catalog: readonly string[]): string {
  const [first, ...rest] = scopes.map((scope) => (scope ? scope.split("/") : []));
  if (!first) return "";
  let depth = 0;
  while (depth < first.length && rest.every((parts) => parts[depth] === first[depth])) depth++;
  return scopeOfDir(catalog, first.slice(0, depth).join("/"));
}

/** A window's place (see the header); `prompt` as `windowPaths` takes it. */
export function windowPlace(win: string | undefined, at: RepoScopes, prompt?: readonly string[]): Place {
  return win ? placeOf(windowPaths(win, prompt), at) : taskPlace(prompt ?? [], at);
}

/** The place of a prompt's paths alone: a subagent's task, before its window has recorded anything (A4 §5.3). */
export function taskPlace(paths: readonly string[], at: RepoScopes): Place {
  return placeOf({ prompt: [...paths], batch: [], turns: [], bash: [], sub: [] }, at);
}

/** The place of paths read against a repo. */
export function placeOf(paths: PlacePaths, at: RepoScopes): Place {
  const scopeOf = scopeMapper(at);
  const readSet = readSetOf(scopeWeights(paths, scopeOf), (scopes) => commonScope(scopes, at.scopes));
  const named = [...new Set(paths.prompt.flatMap((path) => scopeOf(path) ?? []))];
  return { readSet, named };
}

/** Whether `under` is `scope` or below it. */
function within(scope: string, under: string): boolean {
  return scope === "" || under === scope || under.startsWith(`${scope}/`);
}

/** Whether a row's kind is visible below its scope: a fact, a policy or an intent (see the header). */
function inherits(row: ProvenanceNote): boolean {
  const kind = noteKindToken(row);
  return kind === "fact" || kind === "rule" || !!row.rules?.length;
}

/**
 * A4 §2's visibility from a place (see the header), and `scopes`: the folders a visible row may be stored at, whatever
 * its kind (the read set's own, their ancestors, and named folders below them), which the postings are read by.
 */
export function visibleFrom(place: Place): ((row: ProvenanceNote) => boolean) & { scopes: (scope: string) => boolean } {
  const visible = (row: ProvenanceNote) => {
    const scope = row.scope;
    if (typeof scope !== "string") return true;
    return place.readSet.some(
      (read) =>
        scope === read || (inherits(row) ? within(scope, read) : within(read, scope) && place.named.includes(scope)),
    );
  };
  const scopes = (scope: string) =>
    place.readSet.some((read) => within(scope, read) || (within(read, scope) && place.named.includes(scope)));
  return Object.assign(visible, { scopes });
}

/**
 * The live rows keying the slots a delivery's candidates state (typed or mined; rows of unknown scope are no
 * folder's), read once per delivery: each slot's value at each folder, the newest row's, and the folders each text
 * is keyed at (a split statement's parts share it). A row is read by its stored keys, or, written before P3.3 kept
 * keys, by its text only when that names one of the slots (`noteSlots`), so the cost is one cheap test per row.
 */
interface Keyed {
  held: Map<SlotId, Map<string, { value: string; row: ProvenanceNote }>>;
  texts: Map<string, Set<string>>;
}

/** Whether row `a` was written after row `b`: by time, then by id (ULIDs sort by time). */
function newer(a: ProvenanceNote, b: ProvenanceNote): boolean {
  return (a.at ?? 0) > (b.at ?? 0) || ((a.at ?? 0) === (b.at ?? 0) && String(a.id) > String(b.id));
}

function keyedRows(live: readonly ProvenanceNote[], slots: ReadonlySet<SlotId>, texts: ReadonlySet<string>): Keyed {
  const keyed: Keyed = { held: new Map(), texts: new Map() };
  for (const row of live) {
    if (typeof row.scope !== "string" || row.rules?.length) continue;
    if (row.slots ? !row.slots.some((ref) => slots.has(ref.k)) : noteKindToken(row) !== "fact") continue;
    if (isUntyped(row) && !isCited(row)) continue;
    if (!row.slots && ![...slots].some((slot) => mayStateSlot(String(row.text ?? ""), slot))) continue;
    const refs = noteSlots(row).filter((ref) => ref.v !== undefined && slots.has(ref.k));
    if (!refs.length) continue;
    for (const { k, v } of refs) {
      const at = keyed.held.get(k) ?? keyed.held.set(k, new Map()).get(k)!;
      const held = at.get(row.scope);
      if (!held || newer(row, held.row)) at.set(row.scope, { value: v!, row });
    }
    const text = String(row.text ?? "").trim();
    if (texts.has(text)) (keyed.texts.get(text) ?? keyed.texts.set(text, new Set()).get(text)!).add(row.scope);
  }
  return keyed;
}

/**
 * D5's value of a slot at a folder (A4 §2): the one held at the folder itself, else at its nearest ancestor that
 * holds one, looking no higher than `below` (exclusive) when given.
 */
function heldValue(keyed: Keyed, slot: SlotId, folder: string, below?: string): string | undefined {
  const values = keyed.held.get(slot);
  for (let at: string | undefined = folder; values && at !== undefined && at !== below; at = parentScope(at))
    if (values.has(at)) return values.get(at)!.value;
  return undefined;
}

/** A scope's parent ("packages/cli" → "packages" → ""); none above the root. */
export function parentScope(scope: string): string | undefined {
  return scope ? scope.slice(0, Math.max(0, scope.lastIndexOf("/"))) : undefined;
}

/** The slots a typed fact's text states: a split part's other part's among them (`otherPartValues`). */
function textSlots(note: ProvenanceNote): SlotId[] {
  return note.slots && !isUntyped(note) ? slotsIn(bodyOf(note)).map(({ slot }) => slot) : [];
}

/**
 * The values a split statement's part states without keying them (A4 §3.2: a statement of a root and a working slot
 * typed in a folder is two rows of one text, each keyed at its own scope): its text's other values, when another
 * live row keys the same text at another scope. None for any other row.
 */
function otherPartValues(note: ProvenanceNote, keyed: Keyed): { slot: SlotId; value: string }[] {
  if (!note.slots || isUntyped(note)) return [];
  const body = bodyOf(note);
  if (![...(keyed.texts.get(body) ?? [])].some((scope) => scope !== note.scope)) return [];
  const own = new Set(note.slots.map((ref) => ref.k));
  return slotsIn(body).flatMap(({ slot, value }) => (value === undefined || own.has(slot) ? [] : [{ slot, value }]));
}

/** A slot fact said by its own keys alone ("Package manager: pnpm"), after the label a retrieved note carries. */
function ownValues<T extends ProvenanceNote>(note: T): T {
  const { label, body } = stripPacketLabel(String(note.text ?? ""));
  const said = noteSlots(note).flatMap(({ k, v }) => {
    if (v === undefined) return [];
    const name = slotLabel(k);
    return [`${name.charAt(0).toUpperCase()}${name.slice(1)}: ${typedValue(body, k, v)}`];
  });
  return { ...note, text: `${label}${said.join("; ")}` };
}

/**
 * D5 at the read set (see the header): each fact as a reader there may be given it. A slot fact is left out when, at
 * a read-set folder at or below its scope, a folder between holds its own value of a slot it keys (equal or not: that
 * folder has a row of its own). A split statement's part is said by its own keys alone where the other part's value
 * does not hold. `live` is the store's live rows, the prompt's own included, as delivery reads them after the prompt
 * is stored. A value its own scope ended is validity's (D31), clause by clause; a row of unknown scope is shown as
 * before.
 */
export function cascaded<T extends ProvenanceNote>(
  notes: readonly T[],
  live: readonly ProvenanceNote[],
  readSet: readonly string[],
): T[] {
  const slotsOf = (note: ProvenanceNote) => noteSlots(note).flatMap((ref) => (ref.v === undefined ? [] : [ref.k]));
  let keyed: Keyed | undefined;
  return notes.flatMap((note) => {
    const scope = note.scope;
    const slots = slotsOf(note);
    if (typeof scope !== "string" || !slots.length) return [note];
    keyed ??= keyedRows(
      live,
      new Set(notes.flatMap((each) => [...slotsOf(each), ...textSlots(each)])),
      new Set(notes.map(bodyOf)),
    );
    const reads = readSet.filter((read) => within(scope, read));
    if (reads.some((read) => slots.some((slot) => heldValue(keyed!, slot, read, scope) !== undefined))) return [];
    const others = otherPartValues(note, keyed);
    const holds = (read: string) => others.every(({ slot, value }) => heldValue(keyed!, slot, read) === value);
    return [reads.every(holds) ? note : ownValues(note)];
  });
}

/**
 * A4 §5.5's first touch: the slot facts of a scope itself, keyed there by the user or cited from the repo's files
 * (STRONG: a keyed slot, never an episode), newest first. An ancestor's values reach the folder by cascade, at the
 * cue that needs them.
 */
export function scopeFacts<T extends ProvenanceNote>(live: readonly T[], scope: string): T[] {
  return live
    .filter(
      (row) =>
        row.scope === scope &&
        (isCited(row) || !isUntyped(row)) &&
        !row.rules?.length &&
        noteSlots(row).some((ref) => ref.v !== undefined),
    )
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/**
 * What encoding gives a row its scope from, read when a row is stored: the repo (none where a place is unknown, see
 * the header), and the window's working scope.
 */
export interface EncodePlace {
  repo(): RepoScopes | undefined;
  working(): string;
}

/**
 * The scopes of the catalog that a text's paths are in, in order, with no filesystem access (D3). A relative path is
 * read from the top, else from the session's folder (`cwd`, relative to the top), whichever falls in a folder's scope;
 * one that falls in neither names `""` only when it ends in a file name ("scripts/db.ts"), so prose with a slash
 * ("and/or") names nothing. URLs are no places.
 */
export function namedScopes(text: string, scopes: readonly string[], top: string, cwd = ""): string[] {
  const named: string[] = [];
  for (const raw of text.replace(URL, " ").split(TOKEN_BREAK)) {
    if (!raw.includes("/")) continue;
    const token = raw
      .replace(/[.:!?]+$/, "")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    const rel = isAbsolute(token) ? (token.startsWith(`${top}/`) ? token.slice(top.length + 1) : "") : token;
    if (!rel) continue;
    const reads = (isAbsolute(token) || !cwd ? [rel] : [rel, `${cwd}/${rel}`]).flatMap(insideRepo);
    if (!reads.length) continue;
    const scope = reads.map((read) => scopeOfDir(scopes, read)).find(Boolean) ?? "";
    if ((scope || FILE_NAME.test(basename(rel))) && !named.includes(scope)) named.push(scope);
  }
  return named;
}

/** A relative reading of a path with its `.` and `..` resolved; none when it leaves the repo. */
function insideRepo(read: string): string[] {
  const resolved = posix.normalize(read);
  return resolved === ".." || resolved.startsWith("../") ? [] : [resolved.replace(/^\.\/?/, "")];
}

/**
 * The scope an encoded row is stored at (see the header); none where its place is unknown. `root` is a row D7 or A4
 * §2 writes at `""` unless it names a scope: a rule, or a fact of a root slot.
 */
export function rowScope(text: string, root: boolean, place: EncodePlace): string | undefined {
  const at = place.repo();
  if (!at) return undefined;
  const { scopes, top, cwd } = at;
  const named = namedScopes(text, scopes, top, cwd);
  if (named.length === 1) return named[0]!;
  if (!named.length) return root ? "" : place.working();
  const working = place.working();
  return named.includes(working) ? working : commonScope(named, scopes);
}

/** A text as a regular expression matches it, literally. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The words of a scope's path, as `subjectWords` reads them, which say where a value is, not what it is of. */
function scopeWords(scope: string): Set<string> {
  return new Set(subjectWords(scope.replace(/\//g, " ")));
}

/** The sentences of a text, split as statements are. */
function sentencesIn(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim().replace(/[.!?;]+$/, ""))
    .filter(Boolean);
}

/** A sentence without a leading mention of its scope ("packages/cli has no auth" is "has no auth" there). */
function withoutScope(sentence: string, scope: string): string {
  const lead = new RegExp(String.raw`^(?:in\s+)?${escaped(scope)}(?:'s)?\s*,?\s*`, "i");
  return sentence.replace(lead, "").trim() || sentence;
}

/** A row's text without the label a retrieved note carries (`[fact · 3d · user]`). */
function bodyOf(row: ProvenanceNote): string {
  return stripPacketLabel(String(row.text ?? "")).body.trim();
}

/**
 * Whether a row's text is one clause ("In apps/web the auth provider is Clerk"): only then does a slot's value stand
 * for the row. A longer row says more than its slot ("packages/cli has no auth, and its database is sqlite"), which a
 * merged bullet would lose.
 */
function oneClause(row: ProvenanceNote): boolean {
  const body = bodyOf(row);
  return !/[,;:]|\s(?:and|but)\s/i.test(body) && sentencesIn(body).length === 1;
}

/** A one-clause row's slot as the legacy copula reader parses it (`oneClause`). */
function clauseSlot(row: ProvenanceNote): ReturnType<typeof legacySlot> {
  return oneClause(row) ? legacySlot({ ...row, text: bodyOf(row) }) : undefined;
}

/** A question: it ends with "?", or opens with a question word or an auxiliary. */
const QUESTION = /\?\s*$|^(?:what|which|who|where|when|why|how|do|does|did|is|are|can|could|should|would|will)\b/i;
/** Words before a value's head that say nothing of it ("is a mess", "is really slow"). */
const VALUE_LEAD = /^(?:(?:a|an|the|very|so|really|still|totally|completely|kind of|a bit|pretty|quite)\s+)*/i;
/** Heads of a complaint, which, like D7's status lexicon, describe a state and are never a slot's value. */
const COMPLAINTS = new Set(["mess", "pain", "nightmare", "disaster", "problem", "issue", "headache"]);

/** The sentences of a text that are not questions, without their closing stop. */
function statementsIn(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !QUESTION.test(sentence))
    .map((sentence) => sentence.replace(/[.!?;]+$/, ""));
}

/** Whether a value's head is a state, not a value: D7's status lexicon or a complaint ("is broken", "is a mess"). */
function stateOnly(value: string): boolean {
  const head =
    value
      .replace(VALUE_LEAD, "")
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z]/g, "") ?? "";
  return STATUS_WORDS.has(head) || COMPLAINTS.has(head);
}

/**
 * Whether a statement states a value of one of the subject words, not only names it: the word right before a copula
 * or a verb of use, with a value after it that is no state ("the auth provider is none", "its database runs on
 * sqlite"; not "the auth flow is broken" or "our auth is a mess"); or the word after a verb of having or using ("has
 * no auth", "uses no database"). An instruction naming the word ("make it use the same auth") states none.
 */
function statesSubject(sentence: string, words: ReadonlySet<string>): boolean {
  return [...words].some((word) => {
    const named = `${escaped(word)}s?`;
    const before = new RegExp(String.raw`\b${named}\s+(?:is|are|was|were|uses|runs|goes)\s+(.+)$`, "i").exec(sentence);
    const after = new RegExp(
      String.raw`\b(?:has|have|had|uses|used)\s+(?:no\s+|an?\s+|the\s+)?((?:[\w'-]+\s+){0,2})${named}\b`,
      "i",
    ).exec(sentence);
    const stated = (value: string) => !value.split(/\s+/).some((part) => part && stateOnly(part));
    return (!!before && !stateOnly(before[1]!)) || (!!after && stated(after[1]!));
  });
}

/**
 * A row's value of a D7 slot at its scope (see the header): the one it sets, as it types it, else its sentence naming
 * one of the slot's aliases that states a value of it ("is none", "has no auth").
 */
function keyedValueFor(row: ProvenanceNote, slot: SlotId, scope: string): string | undefined {
  const own = noteSlots(row).find((ref) => ref.k === slot && ref.v !== undefined);
  if (own) return typedValue(bodyOf(row), slot, own.v!);
  // A copula of the slot's subject whose value is in no class ("the auth provider is none").
  const copula = clauseSlot(row);
  if (copula && namesSlot(copula.subject, slot)) return copula.value;
  const aliases = new Set(slotAliases(slot));
  const sentence = statementsIn(bodyOf(row)).find((part) => namesSlot(part, slot) && statesSubject(part, aliases));
  return sentence && withoutScope(sentence, scope);
}

/** A row's value for a slot of these subject words at its scope, if it states one (see the header). */
function valueFor(row: ProvenanceNote, words: ReadonlySet<string>, scope: string): string | undefined {
  const slot = clauseSlot(row);
  if (slot && subjectWords(slot.subject).some((word) => words.has(word))) return slot.value;
  const sentence = statementsIn(bodyOf(row)).find(
    (part) => subjectWords(part).some((word) => words.has(word)) && statesSubject(part, words),
  );
  return sentence && withoutScope(sentence, scope);
}

/** Whether a row can give the other scope's value: the user typed it, and it is a fact or an episode. */
export function typedValueRow(row: ProvenanceNote): boolean {
  const kind = noteKindToken(row);
  return knownNoteSource(row) === "user" && (kind === "fact" || kind === "episode") && !row.rules?.length;
}

/** Whether a text names a scope's path as a whole path. */
function namesScope(text: string, scope: string): boolean {
  return new RegExp(String.raw`(?<![\w./-])${escaped(scope)}(?![\w-])`, "i").test(text);
}

/**
 * A4 §2's two-scope packet (see the header): the candidates, in order, with a slot's value at the other scope of a
 * two-scope read set merged into its bullet, and the rest labelled. `rowsAt` gives a scope's live rows that may give a
 * value (`typedValueRow`), as delivery reads them, newest first; it is asked only for a note that is a slot. A merged
 * or labelled note keeps the rows it shows as `parts`, which the ledger records. A row a merged bullet shows is not
 * given again on its own, whichever of the two ranked first.
 */
export function twoScopeNotes<T extends ProvenanceNote>(
  notes: readonly T[],
  readSet: readonly string[],
  rowsAt: (scope: string) => readonly ProvenanceNote[],
): ProvenanceNote[] {
  if (readSet.length !== 2) return [...notes];
  const pair = readSet as readonly [string, string];
  const placeWords = new Set(pair.flatMap((scope) => [...scopeWords(scope)]));
  const stored = new Map<string, readonly ProvenanceNote[]>();
  const rowsOf = (scope: string) => stored.get(scope) ?? stored.set(scope, rowsAt(scope)).get(scope)!;
  const used = new Set<string>();
  // What merged bullets already say at a scope: a later row saying only that is given by them.
  const said = new Set<string>();
  const out: { key: string; note: ProvenanceNote; merged: boolean }[] = [];
  for (const note of notes) {
    if (used.has(rowKey(note))) continue;
    const scope = note.scope;
    if (scope === undefined || !pair.includes(scope)) {
      out.push({ key: rowKey(note), note, merged: false });
      continue;
    }
    if (said.has(saidAt(scope, withoutScope(bodyOf(note), scope)))) continue;
    const other = scope === pair[0] ? pair[1] : pair[0];
    const candidates = () =>
      [...notes.filter((row) => row.scope === other), ...rowsOf(other)].filter(
        (row) => !used.has(rowKey(row)) && rowKey(row) !== rowKey(note),
      );
    const merged = note.update ? undefined : mergedNote(note, other, pair, placeWords, candidates);
    for (const part of merged?.note.parts ?? []) used.add(rowKey(part));
    for (const [at, value] of merged?.values ?? []) said.add(saidAt(at, value));
    out.push({ key: rowKey(note), note: merged?.note ?? labelled(note, scope), merged: !!merged });
  }
  return out.filter((entry) => entry.merged || !used.has(entry.key)).map((entry) => entry.note);
}

/** A value as said at a scope, compared without case, spacing or a closing stop. */
function saidAt(scope: string, value: string): string {
  return `${scope}\0${value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?;]+$/, "")
    .trim()}`;
}

/** What identifies a row across the packet and the store: its id, or its text when it has none. */
function rowKey(row: ProvenanceNote): string {
  return row.id ?? `text:${row.text ?? ""}`;
}

/**
 * The two-scope bullet of a note's slot (see the header), with the first candidate at the other scope giving that
 * slot's value, and the value it gives at each scope; none when the note is no one-clause slot, or no candidate gives
 * a value.
 */
function mergedNote(
  note: ProvenanceNote,
  other: string,
  pair: readonly [string, string],
  placeWords: ReadonlySet<string>,
  candidates: () => readonly ProvenanceNote[],
): { note: ProvenanceNote; values: Map<string, string> } | undefined {
  const reading = slotReading(note, placeWords);
  if (!reading) return undefined;
  const partner = candidates().find((row) => typedValueRow(row) && reading.valueAt(row, other) !== undefined);
  if (!partner) return undefined;
  const values = new Map([
    [note.scope!, reading.value],
    [other, reading.valueAt(partner, other)!],
  ]);
  const user = knownNoteSource(note) === "user" && knownNoteSource(partner) === "user";
  const merged: ProvenanceNote = {
    id: note.id,
    text: `${reading.label} — ${pair.map((scope) => `${scope}: ${values.get(scope)}`).join(" · ")}`,
    kind: "fact",
    ...(user ? { tags: ["src:user"] } : {}),
    at: Math.max(note.at ?? 0, partner.at ?? 0),
    parts: [note, partner],
  };
  return { note: merged, values };
}

/**
 * How a one-clause note states one slot, for the two-scope bullet (see the header): its label, its value as typed,
 * and how another row gives the slot's value. A D7 slot when the note sets one; else the legacy copula reading of the
 * fact, its subject's words without the read set's place words. None for any other note.
 */
function slotReading(note: ProvenanceNote, placeWords: ReadonlySet<string>) {
  if (!oneClause(note)) return undefined;
  const sets = noteSlots(note).filter((ref) => ref.v !== undefined);
  if (sets.length === 1) {
    const { k: slot, v } = sets[0]!;
    const valueAt = (row: ProvenanceNote, scope: string) => keyedValueFor(row, slot, scope);
    return { label: slotLabel(slot), value: typedValue(bodyOf(note), slot, v!), valueAt };
  }
  const slot = sets.length ? undefined : clauseSlot(note);
  const words = new Set(slot ? subjectWords(slot.subject).filter((word) => !placeWords.has(word)) : []);
  if (!slot || !words.size) return undefined;
  const valueAt = (row: ProvenanceNote, scope: string) => valueFor(row, words, scope);
  return { label: [...words].join(" "), value: slot.value, valueAt };
}

/**
 * A note at one scope of a two-scope read set, labelled with it unless its text names it (D4), after the label a
 * retrieved note carries (`[episode · 1d · user]`), which the packet reads past.
 */
function labelled<T extends ProvenanceNote>(note: T, scope: string): T | ProvenanceNote {
  const { label, body } = stripPacketLabel(String(note.text ?? ""));
  if (!scope || note.update || note.rules?.length || noteKindToken(note) === "rule" || namesScope(body, scope))
    return note;
  return { ...note, text: `${label}${scope}: ${body}`, parts: [note] };
}
