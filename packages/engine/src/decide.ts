/**
 * What the engine knows about each candidate of a no-model decision (docs/research/econ-decide.md): the facts its rule
 * paths already compute (lexical score, matched terms, the conflict test's verdict, the graph's and the cards' reads,
 * the day the request names, a party it names). A lab instrument (D67): the engine reports them through
 * `PartnerDeps.onCandidates` when a harness wires it, and decides nothing from them. The logistic model fitted on them
 * (`packages/sim/src/lab/decide-fit.ts`) added one fact of 268 in-sample and stays in the lab.
 */

/** What the engine knows about one candidate for one request, with no model. Booleans are 0 or 1. */
export interface Facts {
  /** Coverage of the request's terms plus the entity bonus (`rank`). */
  score: number;
  /** Distinct request terms the item holds. */
  matched: number;
  /** Position among the lookup's ranked candidates (0 is the best scored). */
  rank: number;
  /** Score over the best candidate's score (1 for the best). */
  relScore: number;
  /** A whole cue entity in the item. */
  entity: number;
  /** Request words beyond names and time words the item holds (`quietNameOnly`'s count); -1 when not counted. */
  beyond: number;
  /** Something besides a name ties it to the request (`beyondName`). */
  beyondName: number;
  /** It is about what the request names (`about`). */
  about: number;
  /** `conflict.ts` verdict against the request's frame. */
  conflict: number;
  clear: number;
  /**
   * The conflict ground's own test (`grounded`, `groundConflict`): about the request, tied beyond a name, a conflict,
   * and none of bulk, settled or an unmeasured limit.
   */
  conflictHit: number;
  /** The graph's conflict ground's test: a binding walked item in conflict, tied beyond a name, not bulk or a bot's. */
  graphHit: number;
  /** Bulk mail, a settled update, an absence on other days, a clearance (the rule paths' vetoes). */
  bulk: number;
  settled: number;
  awayElsewhere: number;
  /** An event on a day the request names; an item whose text names such a day; any dated item; still to come. */
  onNamedDay: number;
  namesDay: number;
  dated: number;
  upcoming: number;
  /** An absence of someone the request names over a day it names. */
  awayOnDay: number;
  /** Found by a probe for the request's people, organisations or day; a conflicting consequence find. */
  probed: number;
  bridged: number;
  /** Reached by the knowledge graph; its walk score; it constrains a node the walk reached; reached by name. */
  walked: number;
  walkScore: number;
  binds: number;
  walkNamed: number;
  automated: number;
  /** The graph's conflict read (a binding walked item, tied by the nodes it was reached through). */
  graphConflict: number;
  /** An implication card bears on the request; the request violates it; tied by name. */
  carded: number;
  cardViolated: number;
  cardByName: number;
  /** A person the request names takes part in it; it mentions a name the request uses; it names the request's ref. */
  participant: number;
  mentions: number;
  namesRef: number;
  /** A limit on an amount the request does not state. */
  unmeasured: number;
  /** log(1 + days between the item's time and the request), 0 when undated. */
  ageDays: number;
  /** The request: acts on someone, is imperative, is a question, names a day, arrived from outside. */
  acts: number;
  imperative: number;
  question: number;
  hasDays: number;
  external: number;
}

/** The facts in a fixed order: a fitted model's weights (`decide-fit.ts`) are in this order, after the intercept. */
export const FACT_NAMES: readonly (keyof Facts)[] = [
  "score",
  "matched",
  "rank",
  "relScore",
  "entity",
  "beyond",
  "beyondName",
  "about",
  "conflict",
  "clear",
  "conflictHit",
  "graphHit",
  "bulk",
  "settled",
  "awayElsewhere",
  "onNamedDay",
  "namesDay",
  "dated",
  "upcoming",
  "awayOnDay",
  "probed",
  "bridged",
  "walked",
  "walkScore",
  "binds",
  "walkNamed",
  "automated",
  "graphConflict",
  "carded",
  "cardViolated",
  "cardByName",
  "participant",
  "mentions",
  "namesRef",
  "unmeasured",
  "ageDays",
  "acts",
  "imperative",
  "question",
  "hasDays",
  "external",
];

/** The facts as a vector, raw, in `FACT_NAMES` order (a fitted model's scaling is in its weights). */
export function vectorOf(f: Facts): number[] {
  return FACT_NAMES.map((k) => f[k]);
}
