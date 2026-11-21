/**
 * `sourceKindPrior` (D2015, Q7(b) of docs/research/weak-points-1111.md): a static per-connector-kind prior shipped
 * with Eden, so a new user's first lookup routes on more than the flat Beta(1,1) draw. A lookup has nothing to rank
 * on before the backfill's first pages land (o4-new-user §3: 0 of 48 hidden facts in the first 25 s before
 * `syncKick`): the draw each cold source makes decides which few sources a request searches. The draw itself must
 * move — a bounded raise cannot beat the maximum of ~1,000 flat draws (≈0.998) — so the kinds Eden knows a person's
 * requests most often land in (mail, calendar, contacts) draw from a strong posterior and every other kind from a
 * weak one. Each source's own `used`/`shown` overtakes the prior within its first few routed calls.
 *
 * The table is a weight per connector kind, not data: nothing a user wrote decides it (the tenant-prior of
 * o4-new-user §5a stays the owner's decision). Kinds not listed draw the unknown prior — mid tiers are absent on
 * purpose: a kind ~10% of a large connector set shares swamps the elevated kinds again.
 */

import type { Source } from "@eden/sources";

/** The kinds a person's own requests most often land in, best mean first — the first rule matched is the source's. */
export const SOURCE_KIND_PRIOR: readonly { words: readonly string[]; mean: number }[] = [
  { words: ["mail", "gmail", "outlook", "inbox", "email", "smtp", "imap"], mean: 0.75 },
  { words: ["calendar", "gcal", "cal"], mean: 0.75 },
  { words: ["contacts", "directory"], mean: 0.65 },
];

/**
 * Each source's Beta draw parameters for `RouteRequest.priors`: a known kind draws
 * Beta(used + 1 + S·m, shown − used + 1 + S·(1−m)) and an unknown kind Beta(used + 1, shown − used + 1 + S/2),
 * `strength` S pseudo-observations (0: no prior, `route` draws flat as before). At S = 20 a mail draws ≈0.71±0.09
 * against ≈0.38 for the best of 1,000 unknown sources, so the mail and the calendar lead while nothing is learned.
 */
export function sourcePriors(
  sources: readonly Pick<Source, "id" | "description">[],
  strength: number,
): Map<string, { alpha: number; beta: number }> | undefined {
  if (strength <= 0) return undefined;
  const priors = new Map<string, { alpha: number; beta: number }>();
  for (const s of sources) {
    const words = new Set(
      `${s.id} ${s.description}`
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 0),
    );
    const kind = SOURCE_KIND_PRIOR.find((k) => k.words.some((w) => words.has(w)));
    priors.set(
      s.id,
      kind === undefined
        ? { alpha: 0, beta: strength / 2 }
        : { alpha: strength * kind.mean, beta: strength * (1 - kind.mean) },
    );
  }
  return priors;
}
