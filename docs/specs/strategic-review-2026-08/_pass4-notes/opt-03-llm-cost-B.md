# Pass 4 Notes — optimizations/03-llm-cost.md — Agent B (Impact Validator)

Method: spot-verified every code citation backing a $/token/rate claim directly against
`src/eden` (not just trusting the doc's own line numbers), then classified each quantitative
claim as measured / estimated / asserted-with-no-basis, then diffed subject matter against
`features/06-cost-governance.md`.

## Headline judgment

This is an unusually well-calibrated doc. Every code citation I spot-checked (constants, line
numbers, signatures, docstrings) matched exactly — `PRODUCTION_SAMPLE_RATE = 0.012`
(`src/eden/llmops/judges/_sampling.py:12`), `_MAX_ORGS_PER_NIGHT = 20` /
`_MAX_AGENTS_PER_ORG = 3` (`soft_issue_review.py:46-47`), `max_triage_cost_usd_per_day: float =
5.0` (`config.py:1263`) vs. `daily_maintenance_budget_usd: float = 25.0` (`config.py:1278`),
`openrouter_api_key` at exactly `config.py:443`, `cache_reads`/`cache_writes` reading
non-existent `response.usage` attributes (`llm/client.py:634-635`), `_llm_rationale` having zero
callers repo-wide, `_MAX_REACT_CALLS = 8` / `_LLM_TIMEOUT_S = 90.0`
(`triage_agent.py:47,41`), and `UnifiedJudge.score()`'s single batched `route_judge_call(...
max_tokens=450)` (`judges/unified.py:114-121`). No false numbers found. The doc's own
confidence-labeling (explicit "Confidence" section, per-item hedges like "not a measurement,"
"low-to-medium confidence by construction") already does most of the groundedness work a
verifier would normally have to add — that itself is worth noting positively to synthesis.

## IMPACT AUDIT — every $ / token / rate number, classified

| Claim | Location | Class | Notes |
|---|---|---|---|
| `PRODUCTION_SAMPLE_RATE = 0.012` (1.2% judge sampling) | L93 | **Measured** (code constant) | Verified `_sampling.py:12` exact. |
| DeepSeek V4 Flash: $0.14/1M in, $0.28/1M out (cache miss), $0.0028/1M in (cache hit, 98% discount) | L300-301, L367-368 | **Estimated/external** (cited live pricing docs, not Eden-measured) | Correctly labeled "verified live... not a measurement" of Eden's actual usage. Fine as external ground truth for a rate; not a claim about Eden's realized spend. |
| `~60 words (~80 tokens)` for `_INVESTIGATION_SYSTEM_PROMPT` | L302-303 | **Estimated** (eyeballed, not tokenized) | Verified the string at `investigation.py:55-62`; word count is close (~58 words) but "~80 tokens" is not run through an actual tokenizer — reasonable approximation, not measured. Doc doesn't overclaim precision here (uses "~"), so this is fine as-is. |
| "500-2,000 input tokens per call" | L303-304 | **Estimated**, explicitly labeled "a generous estimate" | No token-level trace exists to ground this; doc is honest about it. |
| `$0.00045` per-call cost (2,000in/600out) | L305-306 | **Derived calculation** from the two estimates above | Arithmetic checks: `2000×0.14e-6 + 600×0.28e-6 = 0.00028+0.000168 = 0.000448` ≈ doc's `$0.00045`. Correct math, but built on two unmeasured estimates — still labeled "not a measurement" up front (L294-297). Fine. |
| `≤~$0.20/night, ≤~$6/month` for `_scout_novel_patterns` | L132-136 | **Estimated**, derived from docstring's own `≈$0.01/org/night` × 20 orgs × 30 days | Verified docstring at `soft_issue_review.py:21-25` says "≈$0.01/org/night... well under the $1/org/mo novelty budget" — the doc's $0.20/night, $6/mo figures are a correct extrapolation to system-wide worst case, not in the docstring verbatim. Grounded, correctly derived. |
| `$2/day` evolution loop ceiling | L142 | **Measured** (code constant) | `max_evolution_ops_usd_per_org_day: float = 2.0` at `config.py:1442` confirmed exact; `evolution_loop_enabled: bool = False` at `config.py:692` confirmed. |
| "≈250 LLM-used triages/day at $0.02 each" (at $5 cap) | L313 | **Derived**, correct arithmetic | `5.00 / 0.02 = 250`. Correct. |
| "≈`250 × $0.00045 ≈ $0.11/org/day`" real dropped spend | L314-315 | **Derived**, correct arithmetic | `250 × 0.00045 = 0.1125`. Correct. |
| "the fake number... is **~45× the real number**" | L315-316 | **Derived**, correct arithmetic | `5.00 / 0.11 ≈ 45.4`, and per-call `0.02/0.00045 ≈ 44.4`. Consistent. |
| "fake ≈ real × **40-100**" | L319, L487 | **Asserted with partial basis — flag** | This range appears twice (once in body, once in Confidence section) but no calculation in the doc derives *why* 40-100 rather than staying at the computed ~45×. It reads as a hedge for "realistic volume is below the cap" but the doc's own math only ever produces ~45×, never anything near 100×. This is the one number in the whole file that doesn't trace to an explicit calculation — recommend synthesis either cut it to "~45×, likely lower at realistic (sub-cap) volume" or ask the author to show the derivation for the upper end. |
| "well under $1/org/day" aggregate mis-recorded | L330-335 | **Estimated**, explicitly "low-to-medium confidence... no production call-volume telemetry" | Honestly hedged; not a measurement, doc says so. |
| "up to ~98% per DeepSeek's own pricing) may already be fully banked" | L353, L403 | **External/estimated**, correctly hedged as "unverifiable today" / "instrument and verify," not asserted as realized | Good — doc does not claim Eden is actually getting this discount, only that the pricing schedule implies it could be. |
| "60-80% bill reduction when combined," "cut LLM costs 86%" (Sources section, external blog citations) | L515-518 | **External, ungrounded to any Eden-specific number** | These generic industry stats are cited only as background color at the very end ("Eden's own judge pipeline already matches or beats the sampling/batching norms these sources describe") — they don't feed any Eden dollar figure in the doc. Low materiality; candidate for trimming (see CUT). |

**Net verdict on impact numbers:** no ungrounded/false dollar figures found beyond the one
flagged range (`40-100×`). The doc's overriding finding is itself "there is little/no real
savings opportunity here" — most of the numbers exist to bound a *correctness bug*, not to
justify a savings claim, and are already appropriately hedged as estimates, not measurements.

## CUT

1. **Quote:** `"60-80% bill reduction when combined... "`, `"AI Caching Strategies 2026: Cut LLM
   Costs 86%"` (Sources section, ~L514-518).
   **Reason:** Generic external benchmarks not tied to any Eden-specific number or
   recommendation in this doc — pure context/color. They don't ground any dollar claim above (the
   doc's own Eden-specific estimates are all independently derived from code constants + DeepSeek
   pricing, not from these industry-average figures). Low-value filler; safe to trim from the
   final synthesized doc without losing any Eden-specific finding.

2. **Structural redundancy, not a factual error — flag for synthesis compression rather than a
   line-level cut:** The "Phase 4 (this pass) additions" section (L558-593) restates, nearly
   verbatim, content already fully stated with the same citations in the "Root cause" section
   (L172-236), "Blast radius" section (L292-335), and "Confidence" section (L466-491) earlier in
   the same file. E.g. the 7-hop `org_id` chain is stated in full three times in one document
   (body, Confidence, Phase 4 additions). This isn't false or unverified — it's the multi-pass
   audit-trail format the whole review series uses — but for a synthesized deliverable, the
   Phase-N "additions" sections at the bottom are ~90% duplicate of the body and can be
   compressed to a one-line changelog per phase without losing information.

3. **Already self-flagged as CUT by the doc's own Phase 2 verdict** (not a new finding, just
   confirming it should stay cut): `_scout_novel_patterns` digest/`existing_block` dedup
   (30-50% input-token cut) — doc's own verdict at L532 says "absolute spend is already tiny
   (≤~$6/month...) and the 30-50% figure is an unmeasured structural estimate." Agree this stays
   CUT; flagging only to confirm no reason to resurrect it.

## OVERLAP WITH features/06-cost-governance.md

**Genuine content duplication: none found.** The scope boundary stated at the top of 03
(Eden's own internal LLM spend/COGS vs. 06's customer-facing budget governance) is respected —
no fact, code citation, or dollar figure is restated verbatim in both docs. `06` gestures at 03's
territory in exactly one sentence (§2e: "internal autonomy/evolution spend caps (N22, W24,
W25)") without detail; 03 does the actual deep dive there. This is complementary, not redundant.

**However, there is a real, unacknowledged data-flow dependency between the two docs' subject
matter that neither doc surfaces — this is the most actionable finding of this pass:**

- `03`'s triage ledger bug (fake flat `$0.02` `CostEvent` written via
  `autonomy_policy.record_spend()` → `record_cost_event()`, `closed_loop/autonomy_policy.py:360-376`)
  writes into the **`customer_cost_events`** table (`llmops/cost_ledger.py:279`, `INSERT INTO
  customer_cost_events`).
- `06` §2d documents `UsageService._sum_org_cost_usd()` (`usage_service.py:268-330`) — the
  function whose output feeds `get_budget_status()` (`usage_service.py:334`), which
  `QuotaEnforcementMiddleware._check_hard_limits` calls for **actual request-blocking hard
  enforcement** (06's Path B). I verified directly: `_sum_org_cost_usd`'s own docstring
  (`usage_service.py:269`) says **"Sum monthly Eden COGS for credits enforcement,"** and one of
  its three summed sources is explicitly `customer_cost_events` — **the exact table 03's triage
  bug writes fake dollars into.** `get_budget_status()` then converts the sum to
  `credits_used = usd_to_credits(total_cost_usd)` (`usage_service.py:359`) and compares against
  plan-tier limits.
- **Consequence 03 doesn't mention and 06 doesn't examine:** the triage ledger bug isn't purely
  an "Eden's own telemetry trust" issue as 03 frames it (L285-290, "the ledger reflects metered
  dollars instead of a guess" — framed as internal-only). Because `customer_cost_events` is
  summed into the same free-tier-credit enforcement pool 06 documents as gating real customer
  requests, the fake `$0.02`/real-`$0.00045` mismatch **also slightly pollutes the org's
  actual credit-consumption number that can block that same org's own gateway requests** — a
  small but genuine customer-facing correctness effect 03's "immaterial to Eden's P&L" framing
  (L316) undersells, since the framing there is about Eden's cost, not about the customer's
  credit balance being nudged by ~$0.0196/triage-call in the wrong direction.
- **Compounding wrinkle, worth flagging to whichever doc owns reconciliation:** `06`'s own §2e
  describes `cost_ledger.py`/`customer_cost_events` as **"Internal-only cost tracking (separate
  system, not customer-facing)... used to gate eden's own internal agent loops rather than
  customer spend"** (06 L385-392). That characterization is in tension with (a) `cost_ledger.py`'s
  own module docstring, **"Customer CostEvent ledger... Every customer-visible LLM path should
  call `record_cost_event`"** (`cost_ledger.py:1-4`), (b) the org-scoped API route that reads
  from it, `/orgs/{org_id}/finops` (`api/routes/finops.py:22-23`, docstring: *"Customer FinOps
  API — cost explorer, export, kill-switches"*), and (c) the `_sum_org_cost_usd` credits-enforcement
  role just described. `03`'s own characterization ("Eden's own customer-facing FinOps ledger,"
  L285-286; docstring quote "Customer-visible CostEvent (FinOps explorer)," L278-280) is the more
  accurate one of the two docs on this specific point. Recommend synthesis correct 06 §2e's "not
  customer-facing" framing rather than 03's.
- Net: this is not duplicated content between the two files — it's an **uncalled cross-system
  dependency** that should be reconciled in synthesis (likely as a joint note under both docs, or
  a new cross-cutting finding): fixing 03's `org_id`/fake-`$0.02` bug is not purely an internal
  COGS-hygiene fix, it also improves the accuracy of the credit-consumption figure 06's Path B
  enforcement reads.

**Secondary, minor observation (not overlap, just adjacent):** `06` §2d.1 cites
`autonomous/agent.py:1636-1655` and `improvement/agent.py:956-960` as the "agent self-throttle"
call sites reading `budget_service.get_consumption()` (06's Path A). `03` separately audits a
*different* region of the same file, `autonomous/agent.py`'s `ChatService`/`_call_llm`
(L114-131, L1428-1443, L1684-1717) — the interactive chat copilot's own model routing and cost
write-through, which 03 confirms (correctly) is **not** subject to the `org_id` bug because it
writes `CostEvent`s by hand with `org_id` attached. These are two distinct code regions in the
same file serving two different purposes (self-throttle read vs. cost write) — not duplication,
but worth a one-line cross-reference in synthesis so a reader of both docs doesn't have to
independently notice they're looking at the same file for different reasons.

## NEW FINDINGS

1. **Customer-credit-pool pollution from the triage ledger bug** (detailed above under OVERLAP)
   — the single highest-value new finding from this pass. Recommend synthesis add a short
   cross-reference note in both 03's blast-radius section and 06's §2d, since fixing 03's bug
   has a (small) customer-facing correctness benefit 03's own framing doesn't credit itself with.

2. **06 §2e's "not customer-facing" characterization of `cost_ledger.py`/`customer_cost_events`
   is contradicted by that module's own docstring and by the `/orgs/{org_id}/finops` route's
   docstring** (both say "customer"-facing/-visible) — flag to whichever pass owns 06 for
   correction; 03's characterization of the same table is accurate.

3. **The `40-100×` ratio range (03 L319, L487) is asserted without a shown derivation** — every
   other ratio/dollar figure in this file traces to an explicit calculation; this one doesn't.
   Recommend either deriving it or narrowing to the ~45× the doc's own math supports.

4. No factually false numbers were found anywhere in the doc during spot-verification (11 code
   citations checked against source, all exact). This is worth noting to synthesis as a positive
   signal about this doc's reliability relative to others in the review — Agent A's independent
   fact pass should be weighted accordingly if it also finds a clean record.
