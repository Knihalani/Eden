/**
 * `--ask-diag`'s coverage facts (hidden-funnel.ts; audit 2026-11-06, quality-o7-remaining-gap-not-candidates): for a
 * planted item (hidden or decoy) the ask left out of its candidates (rank -1), whether the intent index could have
 * bridged the request to it. The causes, told apart so the next lever is chosen on evidence (D162, D173):
 * - not sent, prefilter rejects: the card model was never sent the item and the prefilter rejects it, so it holds no
 *   requests. `cardsLean` skipping it is one cause; still queued at the ask is another. The engine's own test
 *   (`readForIntent`, cards.ts) is not in `@eden/engine`'s index, so the lab does not tell the two apart;
 * - not in replay: it holds no requests because the loaded intent replay has no line for its content (a lab
 *   artefact: a live card model would have written some or none; D173), told apart from
 * - no intent requests: it was sent (or the prefilter passes it) and holds none;
 * - requests but no match: it holds requests, but none matches the ask's question well enough (no shared term, a
 *   hit under `intentMinMatched`/`intentMinCoverage`, a passing hit past the engine's cut of the first `intentHits`
 *   raw hits, or one inside the cut and still not a candidate).
 * Ids and numbers only; no item text.
 *
 * Also the funnel's surfaced split (D173, reporting only): each surfaced planted item (delivered or cited by the ask)
 * as reader-flagged, rule-path (delivered by an injection without the reader's flag, by its `why`) or listed-only
 * (cited by the ask with no flag and no delivery), and the planted items' coverage by the intent replay.
 */

/** One planted item's coverage at its ask. */
export interface AskCoverage {
  /** The lane's card model was sent this item's content (any enrichment call). */
  cardRead: boolean;
  /**
   * Not sent to the card model, and the prefilter rejects it. Not the same as `cardsLean` skipping it: an item still
   * queued at the ask, or never drained, is here too (the lab cannot run `readForIntent`; see the header).
   */
  notSentPrefilterRejects: boolean;
  /**
   * Requests the loaded intent replay holds for its content: -1 when the replay has no line for it (told apart from a
   * line with no requests, 0); null with no replay loaded.
   */
  replayRequests: number | null;
  /** Requests the engine held for it when the ask arrived (`CardEnricher.requestsOf`). */
  heldRequests: number;
  /**
   * Its hit for the ask's question in the user's intent index (`CardEnricher.intentFinds`, the question as the engine
   * reads it, requests made before the ask arrived): coverage, matched terms, whether both pass the thresholds, its
   * place among the engine's intent hits (-1 when not one), and `pastCut`: it passes, but only past the engine's cut
   * (the first `intentHits` raw hits, then at most `intentHits` ids). Null when the requests share no term with the
   * question, or hold none.
   */
  intent: { coverage: number; matched: number; passes: boolean; rank: number; pastCut: boolean } | null;
}

/** One hit of `CardEnricher.intentFinds`: the items holding a request, and how well it matches the question. */
export interface IntentFindRow {
  ids: readonly string[];
  hit: { matched: number; coverage: number };
}

/**
 * The planted item's intent hit for the question, as partner.ts's `intentFinds` (:4466-4486) reads
 * `CardEnricher.intentFinds` (cards.ts:1091-1116): the engine asks the store for `hits` raw hits (`cut`: the call
 * with k = `intentHits`), then keeps a hit with at least `minMatched` terms and `minCoverage` coverage, each kept
 * hit's ids not already placed taking the next places (0-based) until `hits` ids are placed. An item placed there has
 * its rank. Otherwise its first passing hit in `all` (an unbounded call: every hash the user holds) is returned with
 * rank -1 and `pastCut` true: it passes, but the engine never sees it. With none, its first hit in `all` is returned
 * with `passes` false. Null when no hit holds it. Pure.
 */
export function intentPlace(
  cut: readonly IntentFindRow[],
  all: readonly IntentFindRow[],
  itemId: string,
  minMatched: number,
  minCoverage: number,
  hits: number,
): AskCoverage["intent"] {
  const passes = (h: IntentFindRow["hit"]) => h.matched >= minMatched && h.coverage >= minCoverage;
  const placed = new Set<string>();
  // The engine's loop: at most `hits` raw hits (the store's own cut), thresholds after, at most `hits` ids.
  for (const { ids, hit } of cut.slice(0, hits)) {
    if (!passes(hit)) continue;
    for (const id of ids) {
      if (placed.size >= hits) break;
      if (placed.has(id)) continue;
      if (id === itemId) {
        return { coverage: hit.coverage, matched: hit.matched, passes: true, rank: placed.size, pastCut: false };
      }
      placed.add(id);
    }
  }
  let failing: AskCoverage["intent"] = null;
  for (const { ids, hit } of all) {
    if (!ids.includes(itemId)) continue;
    if (passes(hit)) return { coverage: hit.coverage, matched: hit.matched, passes: true, rank: -1, pastCut: true };
    failing ??= { coverage: hit.coverage, matched: hit.matched, passes: false, rank: -1, pastCut: false };
  }
  return failing;
}

export type CoverageBucket =
  | "not cached"
  | "not sent, prefilter rejects"
  | "not in replay"
  | "no intent requests"
  | "no shared term"
  | "under thresholds"
  | "past the intentHits cut"
  | "over thresholds";

/** The bucket of a rank -1 item; null when the ask ranked it. Without coverage facts it holds no requests. */
export function coverageBucket(row: {
  rank: number;
  cached: boolean;
  coverage?: AskCoverage | null;
}): CoverageBucket | null {
  if (row.rank !== -1) return null;
  if (!row.cached) return "not cached";
  const c = row.coverage;
  if (c?.notSentPrefilterRejects) return "not sent, prefilter rejects";
  if (!c || c.heldRequests === 0) return c?.replayRequests === -1 ? "not in replay" : "no intent requests";
  if (!c.intent) return "no shared term";
  if (!c.intent.passes) return "under thresholds";
  // Inside the engine's cut and still not a candidate: anchoring (`anchoredIntents`) or ranking left it out.
  return c.intent.pastCut ? "past the intentHits cut" : "over thresholds";
}

export interface CoverageSplit {
  rows: number;
  unranked: number;
  notCached: number;
  notSentPrefilterRejects: number;
  /** No requests because the replay has no line for the item (a lab artefact), apart from `noRequests`. */
  notInReplay: number;
  noRequests: number;
  /** `noSharedTerm + under + pastCut + over`. */
  noMatch: number;
  noSharedTerm: number;
  under: number;
  pastCut: number;
  over: number;
  /** Every row of the variant, ranked or not, whose item the loaded replay has no line for. */
  rowsNotInReplay: number;
}

type DiagRow = { variant: string; rank: number; cached: boolean; coverage?: AskCoverage | null };

/** The rank -1 rows of one variant, by bucket (and every row's replay misses). */
export function coverageSplit(rows: readonly DiagRow[], variant: string): CoverageSplit {
  const s: CoverageSplit = {
    rows: 0,
    unranked: 0,
    notCached: 0,
    notSentPrefilterRejects: 0,
    notInReplay: 0,
    noRequests: 0,
    noMatch: 0,
    noSharedTerm: 0,
    under: 0,
    pastCut: 0,
    over: 0,
    rowsNotInReplay: 0,
  };
  for (const r of rows) {
    if (r.variant !== variant) continue;
    s.rows++;
    if (r.coverage?.replayRequests === -1) s.rowsNotInReplay++;
    const b = coverageBucket(r);
    if (b === null) continue;
    s.unranked++;
    if (b === "not cached") s.notCached++;
    else if (b === "not sent, prefilter rejects") s.notSentPrefilterRejects++;
    else if (b === "not in replay") s.notInReplay++;
    else if (b === "no intent requests") s.noRequests++;
    else {
      s.noMatch++;
      if (b === "no shared term") s.noSharedTerm++;
      else if (b === "under thresholds") s.under++;
      else if (b === "past the intentHits cut") s.pastCut++;
      else s.over++;
    }
  }
  return s;
}

/**
 * The run's summary lines, hidden then decoy; then, with a replay loaded, every row whose item it has no line for
 * (ranked or not). None for a run with no rows.
 */
export function coverageLines(rows: readonly DiagRow[]): string[] {
  const out: string[] = [];
  const replay: string[] = [];
  for (const [variant, name] of [
    ["hidden", "hidden"],
    ["control", "decoy"],
  ] as const) {
    const s = coverageSplit(rows, variant);
    if (s.rows === 0) continue;
    out.push(
      `ask-diag: ${name} rank -1 ${s.unranked}/${s.rows}: ` +
        (s.notCached ? `not cached ${s.notCached}, ` : "") +
        `not sent, prefilter rejects ${s.notSentPrefilterRejects}, not in replay ${s.notInReplay}, ` +
        `no intent requests ${s.noRequests}, requests but no match ${s.noMatch} (no shared term ${s.noSharedTerm}, ` +
        `under thresholds ${s.under}, passes but past the first intentHits raw hits ${s.pastCut}, ` +
        `over thresholds ${s.over})`,
    );
    replay.push(`${name} ${s.rowsNotInReplay}/${s.rows}`);
  }
  if (rows.some((r) => r.coverage && r.coverage.replayRequests !== null)) {
    out.push(`ask-diag: not in replay, every row (ranked or not): ${replay.join(", ")}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The surfaced split and planted coverage (D173): reporting only; the O7 gates are unchanged (D165).

/** The per-task facts the split reads (hidden-funnel.ts's perTask rows). */
export interface SurfacedRow {
  variant: string;
  delivered: boolean;
  askCited?: boolean;
  /** The reader flagged the planted item in the request's last reading. */
  readerFlagged?: boolean;
  /** The planted item was in a pool the reader was given for the request. */
  poolHas?: boolean;
  /** The kind of the injection that delivered it (`sources`, `grounded-conflict`, `fallback`, ...); "" when none. */
  why?: string;
  /** With an intent replay loaded: whether it has a line for the planted item's content. */
  inReplay?: boolean;
}

export type SurfacedBy = "flagged" | "rule path" | "listed only";

/**
 * How a surfaced planted item was surfaced: the reader flagged it (whatever injection carried it); delivered without
 * the flag (a rule path: grounded-*, fallback, sources, cache, anticipated-*); or only listed by the ask, with no flag
 * and no delivery (`readAsk`'s `rest`: chosen minus explicit rejections, partner.ts). Null when not surfaced.
 */
export function surfacedBy(t: SurfacedRow): SurfacedBy | null {
  if (!t.delivered && !t.askCited) return null;
  if (t.readerFlagged) return "flagged";
  return t.delivered ? "rule path" : "listed only";
}

export interface SurfacedSplit {
  tasks: number;
  /** `flagged + rulePath + listedOnly`. */
  surfaced: number;
  flagged: number;
  rulePath: number;
  listedOnly: number;
  /** Rule-path surfacings by `why`, most first. */
  byWhy: Record<string, number>;
  /** In a pool the reader was given, and of those flagged by it. */
  inPool: number;
  flaggedInPool: number;
}

/** One variant's split ("hidden", or anything else for the decoys). */
export function surfacedSplit(rows: readonly SurfacedRow[], variant: string): SurfacedSplit {
  const s: SurfacedSplit = {
    tasks: 0,
    surfaced: 0,
    flagged: 0,
    rulePath: 0,
    listedOnly: 0,
    byWhy: {},
    inPool: 0,
    flaggedInPool: 0,
  };
  const why: Record<string, number> = {};
  for (const t of rows) {
    if ((variant === "hidden") !== (t.variant === "hidden")) continue;
    s.tasks++;
    if (t.poolHas) {
      s.inPool++;
      if (t.readerFlagged) s.flaggedInPool++;
    }
    const by = surfacedBy(t);
    if (by === null) continue;
    s.surfaced++;
    if (by === "flagged") s.flagged++;
    else if (by === "listed only") s.listedOnly++;
    else {
      s.rulePath++;
      const w = t.why || "unknown";
      why[w] = (why[w] ?? 0) + 1;
    }
  }
  s.byWhy = Object.fromEntries(Object.entries(why).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return s;
}

/**
 * The split's lines, hidden then decoys: surfaced = flagged + rule path + listed only, the rule path by `why`, and,
 * with any pool data, flagged in pool beside in pool. Reporting only: the O7 gates read decoys in pool and total
 * surfaced (D165, D173). None for no rows.
 */
export function surfacedLines(name: string, rows: readonly SurfacedRow[]): string[] {
  const out: string[] = [];
  const pooled = rows.some((t) => t.poolHas !== undefined);
  for (const [variant, label] of [
    ["hidden", "hidden"],
    ["control", "decoys"],
  ] as const) {
    const s = surfacedSplit(rows, variant);
    if (s.tasks === 0) continue;
    const why = Object.entries(s.byWhy)
      .map(([w, n]) => `${w} ${n}`)
      .join(", ");
    out.push(
      `${name} ${label} surfaced ${s.surfaced}/${s.tasks}: flagged ${s.flagged}, rule path ${s.rulePath}` +
        (why ? ` (${why})` : "") +
        `, listed only ${s.listedOnly}` +
        (pooled ? `; ${label} in pool ${s.inPool}, ${label} flagged in pool ${s.flaggedInPool}` : ""),
    );
  }
  return out;
}

/**
 * The per-rule precision table (S2, docs/research/fix-s2-rules.md): for each rule path (the delivering injection's
 * `why`; the reader's own push left out), the planted items it delivered, hidden/decoys, three ways: all of them,
 * whatever the reader made of them; unflagged (the reader did not flag them in the request's last reading: what the
 * rule adds); and read unflagged (in that reading's pool and not flagged: what a veto by the reader would remove).
 * Paths with most deliveries first; a path whose decoys outnumber its hidden finds is marked. None for no deliveries.
 */
export function rulePrecisionLines(name: string, rows: readonly SurfacedRow[]): string[] {
  const by = new Map<string, number[]>();
  for (const t of rows) {
    if (!t.delivered || t.why === "reader") continue;
    const w = t.why || "unknown";
    const a = by.get(w) ?? [0, 0, 0, 0, 0, 0];
    const d = t.variant === "hidden" ? 0 : 1;
    a[d]! += 1;
    if (!t.readerFlagged) a[2 + d]! += 1;
    if (!t.readerFlagged && t.poolHas) a[4 + d]! += 1;
    by.set(w, a);
  }
  if (by.size === 0) return [];
  const out = [`${name} rule precision (delivered by path, hidden/decoys: all; unflagged; read unflagged):`];
  const sum = (a: number[]) => a[0]! + a[1]!;
  for (const [w, a] of [...by].sort((x, y) => sum(y[1]) - sum(x[1]) || x[0].localeCompare(y[0]))) {
    const worse = a[1]! > a[0]! ? "  decoys outnumber hidden" : "";
    out.push(`${name}   ${w} ${a[0]}/${a[1]}; ${a[2]}/${a[3]}; ${a[4]}/${a[5]}${worse}`);
  }
  return out;
}

/**
 * Planted coverage of the loaded intent replay: hidden and decoy items with a line, with a warning below 100% (their
 * requests are missing, so every intent screen runs them as if the card model wrote none). Null without `inReplay`.
 */
export function plantedCoverageLine(rows: readonly SurfacedRow[]): string | null {
  const known = rows.filter((t) => t.inReplay !== undefined);
  if (!known.length) return null;
  const count = (hidden: boolean) => {
    const v = known.filter((t) => (t.variant === "hidden") === hidden);
    return [v.filter((t) => t.inReplay).length, v.length] as const;
  };
  const [h, hn] = count(true);
  const [d, dn] = count(false);
  return (
    `planted items with an intent replay line: hidden ${h}/${hn}, decoys ${d}/${dn}` +
    (h === hn && d === dn
      ? ""
      : `  WARNING: below 100% (not in replay: hidden ${hn - h}, decoys ${dn - d}); their requests are missing, so ` +
        "intent screens and --ask-diag misread them (top the file up with cards-enrich.ts --intent)")
  );
}
