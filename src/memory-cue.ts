/**
 * The situation cue (A7 §3, D16): a Submit is cued by its situation, not by its prompt alone. Four parts:
 *
 * - `prompt` (`q_prompt`): the prompt's words, as the lexical path has always read them (paths, snake and kebab case
 *   split; a dotted or camelCase name whole: see `relevant`'s `hayParts`, until P4.3).
 * - `turn` (`q_turn`): the previous typed prompt of the window. It and the parts below are read as identifier-split
 *   tokens (`cueTokens`: a camelCase name or a dotted filename yields its parts too).
 * - `path` (`q_path`): the basename, its stem and the non-generic folders of each path the agent's recent tool calls
 *   touched (`ctx.log`, the last 3 human turns; the newest `PATH_LIMIT`).
 * - `prev` (`q_prev`): the agent's last message (`qprev.json`, or the transcript's tail when newer), minus the tokens
 *   of the packets Eden gave the turn it answers (D16: "Eden's own delivered tokens are stripped"). Its rare-token
 *   selection needs the store's df, so the scorer makes it (`RARE_DF`).
 *
 * Each part is scored separately against a candidate and the parts are summed with the turn mode's weights
 * (`weightsFor`, A7 §3's table). A context part adds at most `PART_MASS` matched words to a row (R2 §5.2's per-part
 * mass limit), so a long, busy context cannot make every row look relevant.
 */
import { identifierTokens, sharesIdentifier, type CueParts } from "./memory-gate";
import { underTop } from "./memory-place";
import { proposalSentences, type TurnMode } from "./memory-turn";

export type CuePart = "prompt" | "turn" | "path" | "prev";
export type CueWeights = Readonly<Record<CuePart, number>>;

/** A7 §3's weights by mode; a mode the table does not name takes `default`. */
const DEFAULT_WEIGHTS: CueWeights = { prompt: 0.55, turn: 0.15, path: 0.15, prev: 0.15 };
const MODE_WEIGHTS: Partial<Record<TurnMode, CueWeights>> = {
  continuation: { prompt: 0.15, turn: 0.15, path: 0.2, prev: 0.5 },
  debug: { prompt: 0.45, turn: 0.1, path: 0.2, prev: 0.25 },
};

/** The weight a default turn gives its prompt: the lexical scorer's unit, so a cue-less score is as before P4.1. */
export const REFERENCE_WEIGHT = DEFAULT_WEIGHTS.prompt;

export function weightsFor(mode: TurnMode): CueWeights {
  return MODE_WEIGHTS[mode] ?? DEFAULT_WEIGHTS;
}

/** The context parts: every part but the prompt. */
export const CONTEXT_PARTS = ["turn", "path", "prev"] as const;

/** R2 §5.2's per-part mass limit, in the lexical scorer's units: matched words a context part adds to one row. */
export const PART_MASS = 2;
/** A7 §4's rare plain word: `q_prev` counts a word only when at most this many rows hold it. */
export const RARE_DF = 50;
/** `q_path` reads the newest paths only: a long turn can touch hundreds. */
const PATH_LIMIT = 8;

/**
 * Folders that say where code sits in any repo, not what it is about: `q_path` leaves them out (A7 §3's "non-generic
 * dir segments"). A workspace bucket (`apps`, `packages`, `services`) names no subject; its member does.
 */
const GENERIC_SEGMENTS = new Set(
  (
    "src lib libs app apps packages pkg internal cmd components component test tests spec specs __tests__ dist build " +
    "public assets static utils util helpers common shared core index main services modules node_modules"
  ).split(" "),
);

/** The words of a text as the lexical path's needles are read (lowercase; dotted names kept whole). */
export function queryHay(text: string): Set<string> {
  return new Set(((s) => s.toLowerCase().match(/[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+/g) ?? [])(text));
}

/**
 * A text's identifier-split tokens (A7 §3): its words (`queryHay`), and each identifier's parts: `publicRoutes` →
 * public, routes; `vitest.config.ts` → vitest.config, vitest, config.
 */
export function cueTokens(text: string): Set<string> {
  const tokens = queryHay(text);
  for (const identifier of String(text ?? "").match(/[A-Za-z0-9][\w.-]*[A-Za-z0-9]/g) ?? []) {
    for (const part of identifier.split(/[._-]+|(?<=[a-z0-9])(?=[A-Z])/)) if (part) tokens.add(part.toLowerCase());
    const stem = /^(.+\.[\w-]+)\.[a-z][a-z0-9]{0,4}$/i.exec(identifier)?.[1];
    if (stem) tokens.add(stem.toLowerCase());
  }
  return tokens;
}

/**
 * R1's plural s-stemming (its BM25F tokenizer, which measured the situation cue's gain): a plain word of four letters
 * or more loses its plural ending, so "queries" meets "query" and "pages" meets "page". Names with digits, dots or
 * underscores are kept as they are.
 */
export function singular(word: string): string {
  if (!/^[a-z]{4,}$/.test(word) || /(?:ss|us|is)$/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/** The words `singular` maps to a stem: the stem itself and its plural forms. */
export function pluralForms(stem: string): string[] {
  const forms = [stem, `${stem}s`, `${stem}es`, ...(stem.endsWith("y") ? [`${stem.slice(0, -1)}ies`] : [])];
  return forms.filter((form) => singular(form) === stem);
}

/**
 * `q_path`'s text: each path's basename and non-generic folders, relative to the repo's top (see the header). With no
 * top to read them against (the wrap's request paths), the basenames alone.
 */
export function pathCue(paths: readonly string[], top?: string): string {
  const words: string[] = [];
  for (const path of [...new Set(paths)].slice(0, PATH_LIMIT)) {
    if (top === undefined) {
      words.push(path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
      continue;
    }
    const inRepo = underTop(path, top);
    if (inRepo === undefined || inRepo.startsWith("..")) continue;
    const segments = inRepo.split("/").filter(Boolean);
    const name = segments.pop();
    if (name) words.push(name);
    words.push(...segments.filter((segment) => !GENERIC_SEGMENTS.has(segment.toLowerCase())));
  }
  return words.join(" ");
}

/** What a Submit's situation holds (see the header). */
export interface Situation {
  /** The previous typed prompt. */
  turn?: string;
  /** `q_path`'s text (`pathCue`). */
  path?: string;
  /** The agent's last message. */
  prev?: string;
  /** The packets Eden gave the turn the agent's last message answers. */
  delivered?: readonly string[];
}

/** The cue a Submit retrieves with (see the header). */
export interface SituationCue {
  mode: TurnMode;
  weights: CueWeights;
  /** Each context part's tokens; the prompt's are read from the lexical path's own cue text. */
  parts: Readonly<Record<(typeof CONTEXT_PARTS)[number], ReadonlySet<string>>>;
  /** A continuation's STRONG evidence from `q_prev` (A7 §2, §4): its identifier-shaped tokens, without Eden's own. */
  strong: ReadonlySet<string>;
  /** The proposal a continuation accepts: what its action classes and slots are read from. */
  proposal: string;
}

/** Eden's own tokens, which `q_prev` drops: every token of the packets it delivered. */
function deliveredTokens(packets: readonly string[]): Set<string> {
  return new Set(packets.flatMap((packet) => [...cueTokens(packet)]));
}

/** A continuation's STRONG tokens: the identifiers of the agent's last message that no packet of Eden's gave it. */
function strongTokens(prev: string, packets: readonly string[]): Set<string> {
  const own = new Set(packets.flatMap((packet) => [...identifierTokens(packet)]));
  return new Set([...identifierTokens(prev)].filter((token) => !sharesIdentifier(new Set([token]), own)));
}

const without = (tokens: ReadonlySet<string>, own: ReadonlySet<string>) =>
  new Set([...tokens].filter((token) => !own.has(token)));

export function situationCue(situation: Situation, mode: TurnMode): SituationCue {
  const own = deliveredTokens(situation.delivered ?? []);
  const prev = situation.prev ?? "";
  const continuation = mode === "continuation";
  return {
    mode,
    weights: weightsFor(mode),
    parts: {
      turn: cueTokens(situation.turn ?? ""),
      path: cueTokens(situation.path ?? ""),
      prev: without(cueTokens(prev), own),
    },
    strong: continuation ? strongTokens(prev, situation.delivered ?? []) : new Set(),
    proposal: continuation ? proposalSentences(prev).join(" ") : "",
  };
}

/** The gate's view of the cue (`memory-gate.ts`): each part as text, `q_prev` without Eden's own words. */
export function gateParts(prompt: string, turn: string, cue: SituationCue): CueParts {
  return {
    prompt,
    turn,
    path: [...cue.parts.path].join(" "),
    prev: [...cue.parts.prev].join(" "),
    ...(cue.strong.size ? { strong: cue.strong } : {}),
  };
}
