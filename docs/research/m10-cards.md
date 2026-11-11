# M10: a micro card tagger in place of the card model's cards (D960–D969)

Status: in progress. The owner's goal: replace Haiku usage with hyper-specialised micro models. M10 takes **cards**:
the structured card (`Card`: kind, actions, entities, span, limit, statement) the background enricher writes for each
item the strict prefilter passes. The micro model must not generate text: it tags spans and classifies fields, once
per item at ingest, on CPU.

## Pre-registered bar (committed before any paid run)

1. **Field agreement with Haiku cards on held-out families**, no worse than Haiku's agreement with itself (a sample
   re-carded twice in other batches, as M7's `self-agree.ts`): constraint flag, kind, actions (Jaccard), span (start
   and end exact), limit (value exact), entities (token Jaccard), each at or above Haiku-vs-Haiku on the same items.
2. **Funnel ($0) with micro cards in place of Haiku cards**, against main: hidden surfaced within −1% (relative),
   decoys surfaced not up, neutral packets not up.
3. **Pi pair against main**: hidden facts' template-clustered lower bound > −2 points, concerns not up by more than 1
   per 1,000 tasks; cap $8.
4. **Size and speed**: ≤ 1 ms per item at ingest in TypeScript, ≤ 4 MB shared model.
5. **Hard gates**: M3's 52 short-constraint fixtures (`packages/sim/lab/m3r/short-constraints.jsonl`) read as
   constraints (flag) at least as often as Haiku reads them, and M10's field fixtures (dates, amounts, entities in
   short and long items) all pass.

All five hold, or the trial is deleted with its code and tests (D814).
