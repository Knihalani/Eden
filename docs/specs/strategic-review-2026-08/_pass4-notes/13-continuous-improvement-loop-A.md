# Pass 4 notes — F13 (`features/13-continuous-improvement-loop.md`) — Agent A (Fact-Verifier & Pruner)

Scope note up front: the doc's H1 is "F13 — Closing eden's production-data → detection
feedback loop," which is the accurate description of what the doc actually covers — the
`soft_issue_review.py` shadow-detector confirm/dismiss lifecycle (org-scoped `nl_signals`
rows → `detection_settings.resolve_profile()`). This is narrower than the filename
`13-continuous-improvement-loop.md` implies, and narrower than KNOWN-SUBSYSTEMS.md's framing.
See NEW FINDINGS #1 below — this is the single most important thing for synthesis to resolve.

## VERIFIED

Every file:line citation in the doc that I spot-checked against live code this pass
re-verified exactly. I did not find a single wrong line number or mischaracterized behavior.
Checked directly against source (not just the doc's own claims):

- `SoftIssueReviewer` class + methods, `src/eden/services/soft_issue_review.py`: `run_once`
  `:56`, `_hot_agents` `:119`, `_scout_novel_patterns` `:248`, `_create_shadow_detector` `:333`,
  `promote_shadow_detectors` `:380`, `evaluate_shadow_precision` `:510`, `record_shadow_feedback`
  `:571` — all confirmed exact.
- `f"[auto:{agent_id}] "` prefix string at `soft_issue_review.py:363` — confirmed exact.
- `evaluate_shadow_precision`'s `labeled > 0` branch at `:546`, `sample >= min_firings and
  precision is not None` gate at `:557` — confirmed. Since `record_shadow_feedback` (`:571`)
  has **zero production callers** (confirmed by grep — only its own `def`, its own debug log
  line, and an `__all__`-style export list match; re-confirmed independently this pass), every
  row processed by `promote_shadow_detectors` has `confirms=dismisses=0` → `labeled=0` → always
  takes the `else` branch → `precision=None` → the promote/delete gate at `:557` can never fire
  on precision (only `"hold"` is reachable via this path). **This is the doc's central claim
  and it holds up completely.**
- `nl_signals` WHERE clause (`enabled = FALSE AND cluster_id LIKE 'auto:%'`) at
  `soft_issue_review.py:406` — confirmed exact match to the doc's SQL block.
- `agent_issues.py` resolve flow: `resolve_issue` def `:167`, gate `if ok and target ==
  "resolved":` at **exactly `:180`**, two separate `_repo.get_issue` calls at `:190` and `:209`
  — all three line numbers confirmed exact.
- `issue_promoter.py`: `_insert` def `:69`, `INSERT INTO agent_issues` at `:81` — confirmed
  exact; `detail` column genuinely absent from that INSERT's column list.
- `issues/repo.py`: `get_stumble` def `:193` — confirmed exact, SQL body matches doc's quote
  verbatim (`SELECT * FROM agent_stumbles WHERE org_id = $1 AND id = $2::uuid`). Its only caller
  is `agent_issues.py:311` (the standalone `GET .../stumbles/{stumble_id}` route def at `:307`)
  — confirmed exact, matches doc's "one existing caller" claim.
- `signals/investigator.py`: `_maybe_write_stumble` def `:357`, `detail={` opens at `:388`,
  `detected_by="signal_investigator"` at `:394` — confirmed exact.
- `storage/postgres.py`: `fetchrow` def `:839`, `return dict(row) if row else None` at `:847` —
  confirmed exact. Zero `set_type_codec` registrations anywhere in the file — confirmed by grep
  (doc's claim holds).
- `api/routes/agent_issues.py:271` — `_serialize_stumble` def location confirmed exact
  (doc cites `:271-278`). **Independently re-verified the actual bug**, not just the line
  number: the function only coerces `datetime` and `uuid.UUID` values — no `json.loads` of
  `detail` anywhere in it — so the doc's claim that this existing endpoint already ships the
  latent JSON-string bug to the portal is correct as written.
- `db_migrations/versions/084_agent_issues.py`: `detail JSONB NOT NULL DEFAULT '{}'::jsonb` at
  `:54`, `agent_id VARCHAR(256)` at `:49` and `:93` — confirmed exact.
- `db_migrations/versions/090_nl_signals.py`: `revision = "090"`, `down_revision = "089"` —
  confirmed exact.
- `db_migrations/versions/142_session_summaries.py`: `revision = "142_session_summaries"`,
  `down_revision = "141_ci_eval_run_metadata"` — confirmed exact (and it is genuinely the most
  recent file in the chain — `ls .../versions/*.py` returns 149 `.py` files, 150 counting the
  directory entry count the doc likely used; not worth flagging as an error).
- `db_migrations/runner.py:1` docstring ("Run Alembic migrations at API boot...") — confirmed
  exact, supports the doc's correction that the live migration chain is `db_migrations/versions/`
  not the top-level `migrations/` directory.
- `workers/trace_finalized_consumer.py`: `_resolve_profile` def `:634`, and the one real call
  site — `agent_id=data.get("agent_id") or None` at `:314`, `detection_profile=await
  _resolve_profile(org_id)` at `:317`, both inside the same `self._scanner.scan(...)` call
  starting `:311` — confirmed exact, matches doc's claim that the `agent_id` value is trivially
  available two lines above where it would be needed.
- `workers/cron_tick.py`: nightly `soft_issue_review` slot pinned to 03:30 UTC, comment at
  `:410` ("Own 03:30 UTC slot..."), `_run_soft_issue_review` calling `SoftIssueReviewer().
  run_once()` at `:562`, and the weekly `promote_shadow_detectors` wrapper at `:567-569` —
  confirmed, matches doc's `:409-420` and `:566-569` citations.
- `detection_settings.py`: `VALID_PROFILES` `:22`, `_DEFAULT_PROFILE` `:23`, `_CACHE_TTL_S`
  `:24`, `_cache` `:27`, `resolve_profile(org_id: str) -> str` def `:115` — all confirmed exact.
- Minor: `097_signal_definitions_f35_bridge.py`'s actual `revision` string is `"097b"`
  (`down_revision = "097a"`), not the bare `"097"` the doc's prose might suggest at a skim —
  the doc never actually claims a bare `"097"` revision string (it only cites the filename and
  the `ADD COLUMN IF NOT EXISTS` idiom at `:37-39`, which is correct), so this is not an error,
  just a note for anyone copying the revision-chain pattern verbatim.

**Conclusion: this doc has been re-verified three times now and holds up. Nothing in it is
false. Pass 4 finds no factual corrections needed to the doc's existing content.**

## CUT

- **`## Prior art: precision-gated confirm/dismiss loops outside AI`** (the Bayesian
  spam-filtering / active-learning / precision-recall section, ~9 paragraphs). Reason: this is
  generic, Wikipedia-sourced academic framing that does not change any engineering decision in
  the doc — the doc's own text admits "Web search budget for this session was exhausted before
  deeper fraud-detection-specific and intrusion-detection-specific material... could be pulled
  directly" and that the three citations used are "Wikipedia-tier." It restates in textbook
  language a design (`min_firings`, promote/delete thresholds) the doc has already fully
  specified in Task 1/2. No reader of this doc needs to be told that precision-gated
  confirm/dismiss loops resemble spam filters to act on the P0/P1 plan. Cut for length; if kept
  anywhere, it belongs as a one-line footnote, not a full section with four external citations.
- The parenthetical "(a fully autonomous mutate → canary → statistically-gated promote loop,
  something no researched competitor ships)"-style superlative framing does **not** appear in
  this doc (it's in `INDEX.md` re: the *different* prompt-canary bug — see NEW FINDINGS #1) —
  flagging only so synthesis doesn't accidentally import that sentence into this doc's summary,
  since it describes a different subsystem than the one this doc is about.
- Nothing else in the doc reads as false, unverifiable, or redundant. The doc is unusually
  disciplined for a 3-pass document — every claim is either a direct code citation or explicitly
  marked as a design proposal ("None of the above exists today," "new, undefined-today
  thresholds"). No further cuts recommended.

## USER EXPERIENCE & VALUE (draft — Agent B goes deeper)

Today, from an operator's point of view, this loop is **entirely invisible and inert**:
- The nightly scout silently proposes new shadow detectors (`nl_signals` rows with
  `enabled=FALSE`) that no UI surfaces distinctly from confirmed detectors — an operator has no
  page that says "12 new candidate detectors are waiting for your confirm/dismiss."
- `resolve_issue`/`ignore_issue` — the two actions an operator *already takes constantly* in the
  issues UI — have zero effect on detector quality today, even though the plumbing
  (`record_shadow_feedback`) exists and is a ~15-line wire-up (Task 1(b)/(c) in the doc). This is
  the crux of the value story: **the human labeling effort already happens** (every resolve/
  ignore click is implicitly a confirm/dismiss signal) and is currently thrown away. Wiring P0-A/
  P0-B doesn't ask users to do anything new — it just stops discarding a signal they're already
  producing for free.
- The weekly promote/delete job (`promote_shadow_detectors`) runs on schedule and does nothing
  meaningful today — it's a real cron job burning compute to evaluate a `precision=None` no-op
  for every candidate, every week. There's no failure, no error, nothing an operator would ever
  notice is broken — this is a "confidently doing nothing" failure mode, the most dangerous kind
  because monitoring would show a green, on-schedule job.
- Once wired, the value is compounding and low-effort for the org: shadow detectors that survive
  operator scrutiny get promoted automatically; ones that get dismissed enough get auto-deleted
  (P0-C). This is the mechanism that would let Eden's detection quality *improve with usage*
  without an operator ever opening a "detector tuning" screen — the tuning happens as a side
  effect of normal issue triage.
- Today's counterfactual for a prospect evaluating this: Eden's detection stays static
  (`VALID_PROFILES` fixed at whatever org-level `standard`/`minimal`/`advanced` was set once) no
  matter how many issues get resolved or ignored. A competitor whose loop is wired (Braintrust's
  framing, Lemma's "Reopened if it regresses" framing per the doc's Market Context) can point to
  detection quality that visibly improves; Eden today cannot, despite having strictly more of the
  underlying pieces built than the market-context section gives it credit for.
- Task 2 (per-agent `resolve_profile`) is explicitly framed as a new feature, not a wiring fix —
  worth Agent B assessing whether the UX payoff (per-agent detection sensitivity) is worth
  scoping as its own deliverable vs. bundling, since it's the one part of this doc that isn't
  "flip a switch on an already-built pipe."

## NEW FINDINGS

**1. The "prior finding" about the UUID/string type bug + hardcoded empty-metrics function
does NOT belong to this doc — it belongs to `features/03-prompt-playground.md` /
`INDEX.md` finding #4, and is about a completely different subsystem than the one this doc
covers.** I re-traced it fully against live code and it is accurate (INDEX.md already has it
right); documenting the re-verification here since I was asked to, but flagging clearly that
it is **not evidence of a problem with this doc** — it's evidence the two docs cover genuinely
separate mechanisms that happen to rhyme (both are "shadow → precision-gated promote" loops).

   Re-verified chain, exact file:line:
   - `promotion_candidates.ref_id` is declared `UUID NOT NULL`
     (`src/eden/db_migrations/versions/092_market_ready_consolidated.py:195`).
   - The only autonomous caller, `PromotionLoop._evidence_gate_promote`
     (`src/eden/llmops/promotion.py:343-367`), calls `gate.enqueue(org_id, kind="prompt_version",
     ref_id=f"{agent}:{candidate_version}", status="shadow")` at `:355-359` — `ref_id` is a
     composite string like `"checkout-agent:7"`, not a UUID.
   - `EvidenceGate.enqueue` (`src/eden/promotion/evidence_gate.py:42-49`) has no validation on
     `ref_id`; the `INSERT INTO promotion_candidates` at `:57-68` will fail (asyncpg's UUID
     codec raises on a non-hex string, or Postgres rejects it — either way it raises), caught by
     the bare `except Exception as exc: logger.warning(...); return None` at `:70-72`. **This is
     100%-reproducible, not probabilistic** — every `kind="prompt_version"` enqueue fails,
     always.
   - Back in `promotion.py:361-362`: `if not cid: return False` — so `_evidence_gate_promote`
     always returns `False` for prompt-canary promotion, and `_evaluate_one`
     (`promotion.py:226-231`) always falls through to `return "keep"`. The canary can never
     reach `"promote"` via this path.
   - The human-triggered manual-promote route has the **identical** bug and even surfaces it as
     an explicit error: `src/eden/api/routes/prompt_canary.py:191-201` builds `ref_id=f"{agent}:
     {candidate_version}"` the same way, and when `enqueue` returns `None` it raises `HTTPException
     (status_code=503, detail="EvidenceGate enqueue failed — promote blocked")` — i.e., the code
     already has a message for this exact failure and it fires unconditionally, but nothing in
     the codebase or tests currently trips it (confirmed: no test exercises the real Postgres
     insert path).
   - **Independently, even if the type bug were fixed, promotion still could not succeed**:
     `EvidenceGate._metrics_from_outcomes` (`src/eden/promotion/evidence_gate.py:114-122`)
     hardcodes `if kind != "nudge" or not ref_id: return []` at `:121-122` — so for
     `kind="prompt_version"` (and `"guardrail"`, `"model_routing"`, `"kb_skill"`), the function
     always returns an empty list regardless of `ref_id`. The only escape hatch,
     `evidence.get("control")`/`evidence.get("treatment")` cached values checked at
     `evidence_gate.py:100` and `:109`, are **never written anywhere in the codebase** (grep for
     the literal keys `"control"`/`"treatment"` across `src/eden/promotion/` and
     `src/eden/llmops/promotion.py` returns only the two read sites) — so the cache path is dead
     code too. `evaluate()`/`evaluate_bayesian()` (`evidence_gate.py:150-227`, `:538-592`) will
     therefore always see `len(control) == len(treatment) == 0 < min_n` and return
     `passed=False, recommendation="hold"` for prompt-canary candidates, permanently.
   - **Nuance not spelled out in INDEX.md's finding #4 that's worth adding**: this hardcoded gate
     does NOT break everything — `kind="nudge"` is the one path that was actually built out
     end-to-end (`src/eden/nudges/author.py:39,75,138`, `src/eden/api/routes/learn.py:129,147`
     all call `enqueue(..., kind="nudge", ref_id=nudge_id)` with a real nudge UUID, which
     `_metrics_from_outcomes` explicitly handles via a real join to `nudge_outcomes`/`nudges` at
     `evidence_gate.py:129-144`). So the correct framing is: **EvidenceGate's promotion path
     works for exactly one of its six declared `PromotionKind`s (`"nudge"`), and is structurally
     incapable of ever promoting the other five** (`pr_merge`, `prompt_version`, `guardrail`,
     `model_routing`, `kb_skill`) — `prompt_version` fails on both the UUID bug and the hardcoded
     kind-gate; the other four untested kinds (`pr_merge`, `guardrail`, `model_routing`,
     `kb_skill`) are blocked by the kind-gate alone (worth someone checking whether their
     `ref_id`s are UUID-shaped — `guardrail`'s isn't obviously, per
     `evidence_gate.py:419-443`'s `ref_id` usage as a judge/policy id string).

**2. This doc's own scope gap, confirmed against KNOWN-SUBSYSTEMS.md: `improvement/`
(`planner.py`, `auto_merge.py`, `guardian.py`, `test_gate.py`, `agent.py`,
`issue_patch_trigger.py`, `replay_verify.py`) and `nudges/` are still not folded into this doc
after three passes, despite KNOWN-SUBSYSTEMS.md explicitly flagging both as needing
reconciliation with the `soft_issue_review.py` shadow-detector loop this doc covers.** This
doc's own title (filename `13-continuous-improvement-loop.md`) promises broader scope than its
content delivers; its H1 ("detection feedback loop") is the more honest description. Concretely
verified this pass:
   - `improvement/` is a genuinely separate, much larger closed loop (issue→patch→test→
     auto-merge→auto-revert, 14.5k lines total across the directory) that this doc never
     mentions. It doesn't share code paths with `soft_issue_review.py` at all (no cross-imports
     found via grep) — the two are complementary, not overlapping, exactly as KNOWN-SUBSYSTEMS.md
     says. Whether this doc should absorb `improvement/` coverage, or whether `improvement/`
     deserves its own feature doc, is a synthesis-level scoping call, not something I should
     resolve unilaterally as the pruner — flagging for the parent/synthesis pass.
   - `nudges/` (`engine.py`, `author.py`, `shadow_outcomes.py`) is confirmed as a real,
     genuinely-wired promote/demote lifecycle for nudges specifically (see finding #1's nuance
     above — `NudgeEngine.set_mode` is called from `EvidenceGate.promote_if_passed`/`demote` at
     `evidence_gate.py:295,344`) — this is a *working* precedent for exactly the kind of
     confirm/dismiss → promote loop this doc (F13) is trying to get `nl_signals` onto. Worth this
     doc citing `nudges/`'s working pattern as a template/precedent for its own P0 wiring, since
     it's proof the pattern works in production for at least one `PromotionKind`.

**3. Not a doc error, but worth flagging for synthesis:** two structurally similar
"shadow → confirm/dismiss or statistical-test → promote" loops now exist in the codebase
(`soft_issue_review.py`'s `nl_signals` loop, this doc's subject; and `EvidenceGate`'s
`promotion_candidates` loop, `INDEX.md` finding #4's subject) and neither one currently
promotes anything in production, for two entirely unrelated root causes (dead-code
confirm/dismiss wiring here; a type mismatch + hardcoded kind-gate there). That's a pattern
worth naming explicitly in whatever doc becomes the synthesis's "closing the loop" narrative:
Eden has built this shape of mechanism at least twice and both instances are currently inert.
