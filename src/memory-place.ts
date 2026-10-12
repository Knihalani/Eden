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
 * - **Visibility (A4 §2).** A slot fact (until P3.3, a legacy fact), a policy or an intent is visible at its scope and
 *   below it (D5's cascade, without P3.5's override); a gotcha, procedure or episode at its scope only, and from an
 *   ancestor only when the prompt names its scope; nothing at a sibling. A row with no `scope` was written where its
 *   place was unknown (before P3.2, or in a repo with no catalog, outside git included): it stays visible everywhere,
 *   as every row was, and a window in such a repo reads every row.
 * - **A row's scope (A4 §3.2).** The one scope of the catalog its text names (the root's by a file path in its own
 *   folders, "scripts/db.ts"); of several, the working scope (the
 *   read set's first) when it is one of them, else their common ancestor; naming none, the working scope, or `""` for
 *   a rule (A4 §2: policies are mostly `""`) and for a fact of one of D7's root slots (`default_scope: root`, written
 *   at `""` unless the utterance names a scope). Until P3.3's slot table, a fact is of a root slot when it states
 *   it as a copula's subject or in one of D7's patterns for it (`ROOT_SUBJECT`).
 * - **Two scopes (A4 §2, D4).** When the read set has two scopes and a candidate states a slot at one of them, the
 *   other scope's value for that slot joins it in one bullet: `auth provider — apps/web: Clerk · packages/cli: none`.
 *   Until P3.3's keys, a slot is the legacy copula reading's (`legacySlot`) and its subject's words stand for its
 *   aliases (as in P1.1's switches and D26's rule): the other value is the newest live row the user typed at the other
 *   scope with a sentence naming one of them, read as a slot of the same subject when it is one, else as that
 *   sentence. Every other candidate at either scope is labelled with its scope unless its text names it.
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import { knownNoteSource, noteKindToken, stripPacketLabel, type ProvenanceNote } from "./memory-provenance";
import { legacySlot } from "./memory-residual";
import { realpathOrSelf } from "./memory-repo";
import { repoPathOf, scopeOfDir } from "./memory-scopes";
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

/** A4 §2's visibility from a place (see the header). */
export function visibleFrom(place: Place): (row: ProvenanceNote) => boolean {
  return (row) => {
    const scope = row.scope;
    if (typeof scope !== "string") return true;
    return place.readSet.some(
      (read) =>
        scope === read || (inherits(row) ? within(scope, read) : within(read, scope) && place.named.includes(scope)),
    );
  };
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
    const reads = isAbsolute(token) || !cwd ? [rel] : [rel, `${cwd}/${rel}`];
    const scope = reads.map((read) => scopeOfDir(scopes, read)).find(Boolean) ?? "";
    if ((scope || FILE_NAME.test(basename(rel))) && !named.includes(scope)) named.push(scope);
  }
  return named;
}

/**
 * D7's root slots (`pkg.manager`, `commit.style`, `branch.base`, `gh.account`, `ci.system`, `deploy.target`), as a
 * fact states one until P3.3's slot table: as a copula's subject ("The package manager is pnpm"), or in the patterns
 * D7 gives them their values by ("we use pnpm", "we deploy to fly.io", "PRs go against develop"). A fact that only
 * mentions one ("hosted on their cloud", "run through npm scripts") is of its own subject's slot.
 */
const ROOT_SUBJECT = new RegExp(
  String.raw`^(?:(?:the|our|this repo'?s?)\s+)?(?:package manager|commit (?:style|messages?)|(?:base|default) branch|` +
    String.raw`(?:github|gh) account|ci(?: system)?|continuous integration|deploy(?:ment)? target|deployments?|hosting)$`,
  "i",
);
const ROOT_STATEMENT = new RegExp(
  String.raw`\b(?:we|i)\s+(?:always\s+)?(?:use|run)\s+(?:npm|pnpm|yarn)\b|\bwe\s+(?:deploy|host)\s+(?:to|on)\b|` +
    String.raw`\bprs?\s+(?:go|goes)\s+(?:against|into)\b`,
  "i",
);

/** Whether a fact states one of D7's root slots (see `ROOT_SUBJECT`). */
export function namesRootSlot(text: string): boolean {
  const slot = clauseSlot({ text, kind: "fact" });
  return (!!slot && ROOT_SUBJECT.test(slot.subject.trim())) || ROOT_STATEMENT.test(text);
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
 * A row's slot when it is one copula clause ("In apps/web the auth provider is Clerk"): the legacy reader parses a
 * longer row's clauses as one subject ("packages/cli has no auth, and its database is sqlite" would be a database
 * of "sqlite" alone), so only such a row's value stands for the row.
 */
function clauseSlot(row: ProvenanceNote): ReturnType<typeof legacySlot> {
  const body = bodyOf(row);
  const clauses = /[,;:]|\s(?:and|but)\s/i.test(body) || sentencesIn(body).length !== 1;
  return clauses ? undefined : legacySlot({ ...row, text: body });
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
 * or labelled note keeps the rows it shows as `parts`, which the ledger records.
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
  const out: ProvenanceNote[] = [];
  for (const note of notes) {
    if (used.has(rowKey(note))) continue;
    const scope = note.scope;
    if (scope === undefined || !pair.includes(scope)) {
      out.push(note);
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
    out.push(merged?.note ?? labelled(note, scope));
  }
  return out;
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
  const slot = clauseSlot(note);
  const words = new Set(slot ? subjectWords(slot.subject).filter((word) => !placeWords.has(word)) : []);
  if (!slot || !words.size) return undefined;
  const partner = candidates().find((row) => typedValueRow(row) && valueFor(row, words, other) !== undefined);
  if (!partner) return undefined;
  const values = new Map([
    [note.scope!, slot.value],
    [other, valueFor(partner, words, other)!],
  ]);
  const user = knownNoteSource(note) === "user" && knownNoteSource(partner) === "user";
  const merged: ProvenanceNote = {
    id: note.id,
    text: `${[...words].join(" ")} — ${pair.map((scope) => `${scope}: ${values.get(scope)}`).join(" · ")}`,
    kind: "fact",
    ...(user ? { tags: ["src:user"] } : {}),
    at: Math.max(note.at ?? 0, partner.at ?? 0),
    parts: [note, partner],
  };
  return { note: merged, values };
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
