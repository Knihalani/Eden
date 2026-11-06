/**
 * `--ask-diag`'s coverage facts (hidden-funnel.ts; audit 2026-11-06, quality-o7-remaining-gap-not-candidates): for a
 * planted item (hidden or decoy) the ask left out of its candidates (rank -1), whether the intent index could have
 * bridged the request to it. Three causes, told apart so the next lever is chosen on evidence (D162):
 * - lean-skipped: the card model never read the item (`cardsLean` left it out), so it holds no requests;
 * - no intent requests: it was read (or not lean-skipped) and holds none;
 * - requests but no match: it holds requests, but none matches the ask's question well enough (no shared term, or
 *   a hit under `intentMinMatched`/`intentMinCoverage`, or over them and still not a candidate).
 * Ids and numbers only; no item text.
 */

/** One planted item's coverage at its ask. */
export interface AskCoverage {
  /** The lane's card model was sent this item's content (any enrichment call). */
  cardRead: boolean;
  /** Not read, and the prefilter rejects it: `cardsLean` skipped it (intent and lean on). */
  leanSkipped: boolean;
  /** Requests the loaded intent replay holds for its content; null with no replay loaded. */
  replayRequests: number | null;
  /** Requests the engine held for it when the ask arrived (`CardEnricher.requestsOf`). */
  heldRequests: number;
  /**
   * Its hit for the ask's question in the user's intent index (`CardEnricher.intentFinds`, the question as the engine
   * reads it): coverage, matched terms, whether both pass the thresholds, and its place among the passing hits (the
   * engine keeps the first `intentHits`); null when the requests share no term with the question, or hold none.
   */
  intent: { coverage: number; matched: number; passes: boolean; rank: number } | null;
}

export type CoverageBucket =
  "not cached" | "lean-skipped" | "no intent requests" | "no shared term" | "under thresholds" | "over thresholds";

/** The bucket of a rank -1 item; null when the ask ranked it. Without coverage facts it holds no requests. */
export function coverageBucket(row: {
  rank: number;
  cached: boolean;
  coverage?: AskCoverage | null;
}): CoverageBucket | null {
  if (row.rank !== -1) return null;
  if (!row.cached) return "not cached";
  const c = row.coverage;
  if (c?.leanSkipped) return "lean-skipped";
  if (!c || c.heldRequests === 0) return "no intent requests";
  if (!c.intent) return "no shared term";
  return c.intent.passes ? "over thresholds" : "under thresholds";
}

export interface CoverageSplit {
  rows: number;
  unranked: number;
  notCached: number;
  leanSkipped: number;
  noRequests: number;
  /** `noSharedTerm + under + over`. */
  noMatch: number;
  noSharedTerm: number;
  under: number;
  over: number;
}

type DiagRow = { variant: string; rank: number; cached: boolean; coverage?: AskCoverage | null };

/** The rank -1 rows of one variant, by bucket. */
export function coverageSplit(rows: readonly DiagRow[], variant: string): CoverageSplit {
  const s: CoverageSplit = {
    rows: 0,
    unranked: 0,
    notCached: 0,
    leanSkipped: 0,
    noRequests: 0,
    noMatch: 0,
    noSharedTerm: 0,
    under: 0,
    over: 0,
  };
  for (const r of rows) {
    if (r.variant !== variant) continue;
    s.rows++;
    const b = coverageBucket(r);
    if (b === null) continue;
    s.unranked++;
    if (b === "not cached") s.notCached++;
    else if (b === "lean-skipped") s.leanSkipped++;
    else if (b === "no intent requests") s.noRequests++;
    else {
      s.noMatch++;
      if (b === "no shared term") s.noSharedTerm++;
      else if (b === "under thresholds") s.under++;
      else s.over++;
    }
  }
  return s;
}

/** The run's summary lines, hidden then decoy; none for a run with no rows. */
export function coverageLines(rows: readonly DiagRow[]): string[] {
  const out: string[] = [];
  for (const [variant, name] of [
    ["hidden", "hidden"],
    ["control", "decoy"],
  ] as const) {
    const s = coverageSplit(rows, variant);
    if (s.rows === 0) continue;
    out.push(
      `ask-diag: ${name} rank -1 ${s.unranked}/${s.rows}: ` +
        (s.notCached ? `not cached ${s.notCached}, ` : "") +
        `lean-skipped ${s.leanSkipped}, no intent requests ${s.noRequests}, requests but no match ${s.noMatch} ` +
        `(no shared term ${s.noSharedTerm}, under thresholds ${s.under}, over thresholds ${s.over})`,
    );
  }
  return out;
}
