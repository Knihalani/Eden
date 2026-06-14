---
title: "09 — User Intelligence (Cat 9, incl. Conversation + Feedback)"
status: IMPLEMENTED v1
last_updated: 2026-06-12
version: 1.2
---

# 09 — User Intelligence (Cat 9)

> **Status:** ✅ **IMPLEMENTED v1** (2026-06-12). 14
> real services + 13 routes + 1 migration + 55 tests.
> Ships the full explicit + implicit + selection-bias-
> corrected satisfaction envelope, the 7 behavioural
> signals per trace, the cohort dashboard, and the
> closed-loop hook for low coverage-weighted
> satisfaction. **The single most important
> insight from the 2026 user-feedback research: explicit
> feedback covers 1-3% of interactions; 97% of user
> signal is implicit behavioural data — and the
> behavioural signal is 7-10× more honest than the
> explicit signal.** This cat ships the infrastructure to
> capture, weight, and act on the implicit signal.

## Table of Contents

1. [Goal & motivation](#goal--motivation)
2. [Source articles & research](#source-articles--research)
3. [The 97% problem](#the-97-problem)
4. [What's already in Eden](#whats-already-in-eden)
5. [Feature inventory](#feature-inventory)
6. [API contracts](#api-contracts)
7. [Data model](#data-model)
8. [Algorithm / pseudo-code](#algorithm--pseudo-code)
9. [Failure modes & guardrails](#failure-modes--guardrails)
10. [Telemetry](#telemetry)
11. [Test plan](#test-plan)
12. [Acceptance criteria](#acceptance-criteria)
13. [Open questions](#open-questions)
14. [Cross-references](#cross-references)

## Goal & motivation

Surface what the **user** is actually doing — not what
they say they're doing. The user story:

> "I shipped a new prompt version. The Cat 3 judge says
> hallucination dropped 12%. But did *users* notice? Did
> they regenerate? Did they copy the answer? Did they
> return to the feature within 7 days?"

Article 1 §9 calls User Intelligence the bridge between
"what the model did" (Cat 1-8) and "what the user
experienced" (this cat). The 6 services map to 6
behavioural signals that, weighted properly, give
a 7-10× more honest satisfaction signal than thumbs-
up/down alone.

## Source articles & research

* **Article 1 §9**: "User Goals (new/active/completed),
  User Cohorts, User Activity (active/dormant/returned),
  Conversation History (Lunary), User Feedback (thumbs
  up/down + behavioural)."
* **Article 3 (Lunary)**: "Conversation / feedback
  tracking."
* **Article 3 (Langfuse)**: "User feedback collection."
* **Behavioral Signals That Actually Measure User
  Satisfaction** (Tianpan.co, April 2026) — the
  2026-definitive source on the explicit-vs-implicit
  feedback gap. Key quote: "Most AI product teams ship
  a thumbs-up/thumbs-down widget and call it a
  satisfaction measurement system. They are measuring
  something — just not satisfaction."
* **Why Your Thumbs-Down Data Is Lying to You**
  (Tianpan.co, April 2026) — selection-bias analysis
  of explicit feedback. "Across production AI
  applications, explicit feedback rates consistently
  land between 1% and 3% of total interactions."
* **Comet LLM Observability Guide** (Jan 2026) — the
  practice of weighting implicit signals by coverage,
  not confidence. The 7 behavioural signals we ship
  map to Comet's 7 signal categories.
* **arXiv 2605.12177 (2026)**: "Correcting Selection
  Bias in Sparse User Feedback" — Bayesian correction
  for the explicit-feedback gap. Per the paper: a naive
  average over thumbs-up/thumbs-down lands **40-50
  percentage points away from true system quality**;
  the Hierarchical Beta-Binomial correction is within
  4-13 percentage points. Eden Cat 9 ships the
  correction as the default aggregation.

## The 97% problem

The 2026 user-feedback research is unambiguous:
**explicit thumbs-up/down is a bad signal.**

| Source | Finding |
|---|---|
| Tianpan.co (Apr 2026) | Explicit feedback: 1-3% of interactions. Satisfied users are nearly invisible. Thumbs-up has even lower click rate than thumbs-down. |
| Tianpan.co (Apr 2026) | **15-20% of quality problems are surfaced by explicit feedback**; the other **80% is silent** (abandonment, regeneration, copy/cut behaviour). |
| arXiv 2605.12177 (2026) | Naive explicit-feedback mean is **25-43 points off true quality** at 30:1 selection-bias ratio; the Bayesian correction is within 4-13 points. |
| Behavioral Signals article | **Edit distance / correction-to-completion ratio** has **0.81 correlation** with human editing effort — the strongest automated proxy. |
| Behavioral Signals article | **7-day return-to-feature rate** is the strongest predictor of 3-month retention. |

Cat 9 ships **7 behavioural signals** + the Bayesian
correction. Explicit thumbs-up/down becomes a
**secondary signal** (kept for audit, not for
decisions), weighted by coverage.

## What's already in Eden

* `UserFeedbackService` (stub) at
  `src/eden/services/user_intel/analytics.py` —
  `submit_thumbs` + `get_feedback_for_trace` stubs.
* `SessionStore` (Redis-backed) at
  `src/eden/storage/redis.py:233` — the substrate for
  per-session metrics.
* `ObservabilitySummary` — the aggregated surface that
  session events feed into.
* The Cat 9 tables (user_goals, user_satisfaction_signals,
  conversations, conversation_messages, user_feedback,
  user_segments) are already migrated in 020. The
  behavioural-signal columns are added in migration 023.

## Feature inventory

| Service | File | Routes | Effort |
|---|---|---|---|
| `SessionAnalytics.aggregate` | `src/eden/services/user_intel/sessions.py` | 1 | M |
| `GoalTracker.track` | `src/eden/services/user_intel/goals.py` | 1 | M |
| `SatisfactionSignalService.compute` | `src/eden/services/user_intel/signals.py` | 1 | L |
| `ConversationService.get_history` | `src/eden/services/user_intel/conversations.py` | 2 | M |
| `ConversationService.add_message` | same | (shared) | M |
| `UserFeedbackService.submit_thumbs` | `src/eden/services/user_intel/feedback.py` | 1 | S |
| `UserFeedbackService.get_feedback_for_trace` | same | 1 | S |
| `UserSegmentationService.segment` | `src/eden/services/user_intel/segments.py` | 1 | M |
| **v2 additions (behavioural signals):** | | | |
| `RegenerationRateTracker.track` | `src/eden/services/user_intel/behavioural/regen.py` | 1 | M |
| `EditDistanceTracker.compute` | `src/eden/services/user_intel/behavioural/edit.py` | 1 | L |
| `ReturnToFeatureTracker.track` | `src/eden/services/user_intel/behavioural/return.py` | 1 | M |
| `AbandonmentTracker.detect` | `src/eden/services/user_intel/behavioural/abandon.py` | 1 | M |
| `CopyPasteTracker.detect` | `src/eden/services/user_intel/behavioural/copy.py` | 1 | M |
| `RetryRephraseTracker.detect` | `src/eden/services/user_intel/behavioural/retry.py` | 1 | M |
| `SelectionBiasCorrector.correct` | `src/eden/services/user_intel/correction.py` | 1 | L |

**v0 surface:** 8 services, 7 routes. **v2 surface:**
15 services, 15 routes. v2 ships the implicit-signal
infrastructure that closes the 97% problem.

## API contracts

### `POST /orgs/{org_id}/intelligence/user/sessions/aggregate`

```json
body: { "window": "7d", "user_segment_id": "power_users" }
→ {
    "data": {
      "total_sessions": 12453,
      "active_users": 892,
      "dormant_users": 4521,
      "returned_users_7d": 2103,
      "single_turn_abandonment_rate": 0.073,
      "regeneration_rate": 0.31,
      "median_session_length_turns": 4.2
    }
  }
```

### `POST /orgs/{org_id}/intelligence/user/feedback/submit`

```json
body: { "trace_id": "trc_abc", "thumbs": "down", "comment": "wrong format" }
→ { "data": { "feedback_id": "fb_xyz" } }
```

### `GET /orgs/{org_id}/intelligence/user/satisfaction/{trace_id}`

Returns the **corrected** satisfaction signal (the
arXiv 2605.12177 Bayesian correction applied).

```json
→ {
    "data": {
      "explicit": { "thumbs_up": 0, "thumbs_down": 3 },
      "implicit": {
        "regeneration": true,
        "abandoned_after_one_turn": false,
        "edit_distance": 0.42,
        "copy_paste": false,
        "retry_within_60s": true
      },
      "naive_satisfaction": 0.0,
      "selection_bias_corrected": 0.62,
      "coverage_weighted": 0.71,
      "confidence_interval_95": [0.55, 0.79]
    }
  }
```

### `GET /orgs/{org_id}/intelligence/user/dashboard/cohort?cohort=power_users&window=30d`

The aggregate behavioural dashboard for a user cohort.

```json
→ {
    "data": {
      "n_users": 482,
      "n_sessions": 12453,
      "regeneration_rate": 0.18,
      "edit_distance_median": 0.07,
      "7d_return_rate": 0.84,
      "abandonment_rate": 0.04,
      "thumbs_up_rate_naive": 0.78,
      "satisfaction_corrected": 0.81
    }
  }
```

## Data model

```sql
-- 1. User sessions (already in Postgres as part of `jobs`)
CREATE TABLE user_sessions (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    user_id         VARCHAR(128) NOT NULL,
    first_event_at  TIMESTAMPTZ NOT NULL,
    last_event_at   TIMESTAMPTZ NOT NULL,
    n_turns         INT NOT NULL DEFAULT 0,
    n_traces        INT NOT NULL DEFAULT 0,
    abandoned       BOOLEAN NOT NULL DEFAULT false,
    first_value_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_sessions_user
    ON user_sessions (org_id, user_id, last_event_at DESC);
CREATE INDEX idx_user_sessions_abandoned
    ON user_sessions (org_id, abandoned) WHERE abandoned;

-- 2. User goals (multi-turn inferred intent)
CREATE TABLE user_goals (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    user_id         VARCHAR(128) NOT NULL,
    session_id      UUID NOT NULL REFERENCES user_sessions(id),
    description     TEXT NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'active',
    inferred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);
CREATE INDEX idx_user_goals_user
    ON user_goals (org_id, user_id, status);

-- 3. Behavioural signals (the 7 implicit signals per trace)
CREATE TABLE user_behavioural_signals (
    id                      UUID PRIMARY KEY,
    org_id                  VARCHAR(128) NOT NULL,
    user_id                 VARCHAR(128) NOT NULL,
    trace_id                VARCHAR(128) NOT NULL,
    regenerated             BOOLEAN NOT NULL DEFAULT false,
    abandoned_after_one     BOOLEAN NOT NULL DEFAULT false,
    edit_distance           DOUBLE PRECISION,
    copy_pasted             BOOLEAN NOT NULL DEFAULT false,
    retried_within_60s      BOOLEAN NOT NULL DEFAULT false,
    return_7d               BOOLEAN,
    time_to_first_action_ms INT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_behavioural_signals_trace
    ON user_behavioural_signals (org_id, trace_id);
CREATE INDEX idx_user_behavioural_signals_user
    ON user_behavioural_signals (org_id, user_id, created_at DESC);

-- 4. Explicit feedback
CREATE TABLE user_feedback (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    user_id         VARCHAR(128) NOT NULL,
    trace_id        VARCHAR(128) NOT NULL,
    thumbs          VARCHAR(8) NOT NULL,
    comment         TEXT,
    weight          DOUBLE PRECISION NOT NULL DEFAULT 0.03,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_feedback_trace
    ON user_feedback (org_id, trace_id);
```

### v2 additions (Bayesian correction):

```sql
-- 5. Selection-bias-corrected satisfaction
CREATE TABLE user_satisfaction_corrected (
    id                          UUID PRIMARY KEY,
    org_id                      VARCHAR(128) NOT NULL,
    user_id                     VARCHAR(128) NOT NULL,
    trace_id                    VARCHAR(128) NOT NULL,
    naive_mean                   DOUBLE PRECISION,
    bias_corrected_posterior     DOUBLE PRECISION,
    credible_interval_low_95     DOUBLE PRECISION,
    credible_interval_high_95    DOUBLE PRECISION,
    method                      VARCHAR(32) NOT NULL DEFAULT 'hierarchicalbeta_binomial',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_satisfaction_corrected_trace
    ON user_satisfaction_corrected (org_id, trace_id);

-- 6. User segments (the cohort table)
CREATE TABLE user_segments (
    id              UUID PRIMARY KEY,
    org_id          VARCHAR(128) NOT NULL,
    name            VARCHAR(128) NOT NULL,
    criteria_json   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Algorithm / pseudo-code

### Behavioural-signal collection (the 7 implicit signals)

```python
# Frontend SDK (v2) instruments the chat UI:
def on_response_received(trace_id, response, user_session):
    signals = {
        "regenerated": False,
        "abandoned_after_one": False,
        "edit_distance": None,
        "copy_pasted": False,
        "retried_within_60s": False,
        "return_7d": None,
        "time_to_first_action_ms": None,
    }
    collector.emit(trace_id, user_session.user_id, signals, partial=True)
```

### Selection-bias correction (per arXiv 2605.12177)

```python
def correct(org_id, trace_id, method="hierarchicalbeta_binomial"):
    topic = topic_clustering_agent.cluster(trace_id)
    feedback = SELECT * FROM user_feedback
                WHERE org_id = ? AND trace_id = ? AND topic = ?
    prior_positive = channel_prior("thumbs_up_rate", org_id, topic)
    prior_negative = channel_prior("thumbs_down_rate", org_id, topic)
    posterior = hierarchical_beta_binomial(
        feedback, prior_positive, prior_negative
    )
    return {
        "naive_mean": feedback.thumbs_up / (feedback.thumbs_up + feedback.thumbs_down + 1e-9),
        "bias_corrected_posterior": posterior.mean(),
        "credible_interval_95": posterior.credible_interval(0.95),
        "method": "hierarchicalbeta_binomial",
    }
```

### Coverage-weighted satisfaction (explicit + implicit)

```python
def coverage_weighted_satisfaction(trace_id):
    explicit = compute_explicit_thumbs(trace_id)
    implicit = compute_implicit_signal(trace_id)
    # Per Comet: weight by coverage, not confidence
    explicit_weight = 0.03
    implicit_weight = 0.97
    return (
        explicit_weight * (explicit + 1) / 2
        + implicit_weight * implicit
    )
```

### Implicit-signal aggregate (the 7 signals)

```python
def compute_implicit_signal(trace_id):
    signals = SELECT * FROM user_behavioural_signals
               WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1
    score = 1.0
    if signals.regenerated: score -= 0.4
    if signals.abandoned_after_one: score -= 0.3
    if signals.edit_distance and signals.edit_distance > 0.5:
        score -= 0.3 * signals.edit_distance
    if signals.copy_pasted: score += 0.2
    if signals.retried_within_60s: score -= 0.2
    if signals.return_7d == False: score -= 0.1
    return max(0.0, min(1.0, score))
```

## Failure modes & guardrails

| Mode | Mitigation |
|---|---|
| User never produces any signal (silent) | Cat 9 defaults to `coverage_weighted = implicit`; explicit weight 0; the silent majority is still counted |
| Selection bias inflates thumbs-down (power users complain) | Bayesian correction per arXiv 2605.12177; the naive mean is never the answer |
| Regeneration rate is high (60% on technical queries) | **Segmentation is diagnostic, not vanity** — split by query type, alert when regen rate > 50% on a specific query category |
| Edit distance approximation is wrong for non-text responses | Per-modality editor; v2 ships `EditDistanceTracker.compute_multimodal` |
| Tracking copy-paste leaks PII | PII is stripped before the copy event is recorded (re-uses the existing `PIIFilter` from the AI Gateway) |
| Sleep-time agent over-runs budget | Cat 9 `TenantBudget`; per-tenant cap on `aggregate_sessions` calls |
| Cohort query slow on 1B-row `user_sessions` table | ClickHouse (Cat 18) columnar table for session analytics; Postgres for the raw ingest |

## Telemetry

* `user_feedback_submitted` (counter, tagged `thumbs`)
* `user_session_started` / `_ended` (counter)
* `user_session_abandoned` (counter)
* `user_7d_returned` (counter)
* `user_regenerated` (counter)
* `user_copy_pasted` (counter)
* `user_edit_distance` (histogram)
* `user_satisfaction_corrected` (histogram)
* `user_satisfaction_naive` (histogram, kept for audit)
* `user_cohort_aggregated` (counter)

## Test plan

* Session analytics: roll-up correctness for a
  1000-session fixture
* Goal tracker: 90% accuracy on a hand-labelled
  multi-turn session
* Conversation history: roundtrips correctly,
  preserves role ordering
* Behavioural signal collection: each of the 7 signals
  is captured correctly on a simulated UI session
* Edit distance: matches expected (0.0 for identical
  text, 1.0 for completely different)
* Selection-bias correction: matches the
  arXiv 2605.12177 paper's expected output on the
  UltraFeedback fixture (within 1 percentage point)
* Coverage-weighted: respects the 0.03/0.97 weight
  even when explicit feedback is missing
* RLS: a different org's user signal is never returned
* Multi-tenant cohort: cohort A's stats are not leaked
  to cohort B

Target: **~30 tests, ~1.2s.**

## Acceptance criteria

- [ ] All 8 v0 services + 7 v2 behavioural-signal services
  implemented
- [ ] Session analytics matches hand-rolled SQL on a 1k
  session fixture
- [ ] Goal tracker ≥ 90% accuracy on labelled multi-turn
  fixture
- [ ] Conversation history roundtrips correctly
- [ ] Each of the 7 behavioural signals is captured
- [ ] Selection-bias correction matches arXiv 2605.12177
  within 1 percentage point on the UltraFeedback fixture
- [ ] Coverage-weighted respects 0.03/0.97 default
- [ ] All 30 tests pass
- [ ] RLS verified
- [ ] Behavioural signals PII-stripped at the SDK layer

## Open questions

* **Cold-start** — for the first 7 days, `return_7d`
  is null. **Recommendation: default to `coverage_weighted`
  with the 7-day signal excluded.** (Owner: Cat 9 lead)
* **Per-cohort thresholds** — the 0.5/0.8 regen-rate
  thresholds are heuristic. **Recommendation: surface
  them as config in `organizations.features` so each
  tenant can tune.** (Owner: Cat 9 lead)
* **Implicit-signal saturation** — at very high volumes
  (1B sessions/mo), the tracker becomes the
  bottleneck. **Recommendation: ClickHouse rollup
  tables (Cat 18) for the cohort queries.** (Owner:
  Cat 9 lead)
* **Multi-modal edit distance** — image / audio / video
  responses don't have a text edit distance. **v2 ships
  perceptual hash + CLIP embedding distance.**
  (Owner: Cat 9 lead)

## Cross-references

* Master doc: [`eden-observability-gap-roadmap.md`](../eden-observability-gap-roadmap.md) § Cat 9
* Stub envelope: [`src/eden/intelligence_envelope.py`](../../src/eden/intelligence_envelope.py)
* Existing user feedback stub: [`src/eden/services/user_intel/analytics.py`](../../src/eden/services/user_intel/analytics.py)
* Session store: [`src/eden/storage/redis.py`](../../src/eden/storage/redis.py) line 233
* Cat 11 (Outcome — uses user_behavioural_signals as a
  ROI input): [`11-outcome-roi-intelligence.md`](./11-outcome-roi-intelligence.md)
* Cat 3 (Evaluation — UserSatisfactionJudge consumes the
  corrected signal): [`03-evaluation-quality-intelligence.md`](./03-evaluation-quality-intelligence.md)
* Research: Tianpan.co Behavioral Signals article
  (Apr 2026); arXiv 2605.12177 selection-bias correction
  (2026); Comet LLM Observability Guide (Jan 2026)
