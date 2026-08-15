# F13 — Eden's continuous improvement loops: closing the detection feedback loop, and documenting the autonomous patch/merge/revert loop

**Status: this is the flagship finding of the entire strategic review (INDEX.md Part 0.1).** Fourth pass. Passes 1–3 verified and progressively de-risked the wiring plan for eden's shadow-detector confirm/dismiss loop (`soft_issue_review.py`); all of that content is unchanged and fully intact below (`## Loop 1`, Task 1, Task 2). This pass closes a scope gap `KNOWN-SUBSYSTEMS.md` flagged across all three prior passes without it being addressed: this doc's title and flagship billing promise a "continuous improvement loop," but its content covered only the shadow-detector mechanics. Pass 4 adds source-verified coverage of eden's second, larger closed loop (`src/eden/improvement/`: autonomous issue → patch → test → auto-merge → auto-revert, `## Loop 2` below), clarifies its relationship to `EvidenceGate`/prompt-canary promotion and `nudges/` (`## A third related mechanism`), cuts a generic prior-art section that restated already-specified design without changing an engineering decision, and adds a `## User Experience & Value` section grounded in the real portal surfaces for both loops.

## TL;DR

Eden already built the detector feedback loop. It just never turned it on, and the wiring plan has more moving parts than "call the function": `signal_id` is stranded one join away on `agent_stumbles.detail` (the getter for that join **already exists**, a correction from the prior pass — but the `detail` column comes back from Postgres as a raw JSON **string**, not a dict, and the prior pass's own code sketch would have thrown `AttributeError` on first real use), `nl_signals` has no `agent_id` column (fixable with a one-column migration + a regex backfill that is reliable in practice but not by construction), and `resolve_profile()` cannot accept per-agent data today — not just because of a missing parameter, but because nothing in the codebase computes a per-agent precision *score* in the first place. `evaluate_shadow_precision`'s output is consumed exactly once, for a Slack message, and never touches a threshold.

None of this changes the headline verdict — still the single highest-leverage wiring fix in the review — but this pass turns the plan into something an engineer can implement directly from this doc without re-deriving the schema questions.

**Cross-reference:** Lemma's confirmed-real "Artifacts" (persistent per-agent behavior record) and "Issue Extraction" (rubric-free online evals) products are covered in depth in `features/15-artifacts-behavior-record.md` and `features/16-issue-extraction-online-evals.md`; not re-derived here.

**Scope, corrected this pass:** eden has built the general shape "shadow candidate → confirm/dismiss or statistical gate → promote/demote" at least three times, in three structurally separate subsystems, and this doc previously covered only one of them:
1. **`nl_signals`/shadow-detector loop** (`soft_issue_review.py`) — this doc's original subject, detailed below as **Loop 1**. Dead-code confirm/dismiss wiring; nothing has ever promoted through it.
2. **`src/eden/improvement/`** — a separate, ~9,800-line autonomous issue → patch → test → auto-merge → auto-revert loop with no code-path overlap with Loop 1 (no cross-imports found via grep). `KNOWN-SUBSYSTEMS.md` flags it as "much bigger than the `soft_issue_review.py` shadow-detector loop... F13 needs to fold this in" — undocumented in this doc through three prior passes, and absent from `features/15-artifacts-behavior-record.md` and `features/16-issue-extraction-online-evals.md` too (zero references to `improvement/`, `guardian.py`, `test_gate.py`, or `auto_merge.py` in either, confirmed by grep). Covered below as **Loop 2**.
3. **`EvidenceGate`/`promotion_candidates`** (`src/eden/promotion/evidence_gate.py`, `src/eden/llmops/promotion.py`) — backs prompt-canary promotion and nudge promotion. Structurally distinct from both loops above; only its `nudges/` instance currently promotes anything in production. Covered below in **`## A third related mechanism`**, including verified facts about why prompt-canary promotion specifically is currently dead.

Loops 1 and 2 are complementary, not overlapping: Loop 1 learns what counts as an issue; `improvement/` autonomously fixes issues once confirmed. All three loops are currently either fully inert (Loop 1, `EvidenceGate` for 5 of its 6 kinds) or working but under-surfaced in the portal (`nudges/`) or working and well-surfaced but with fixable UX gaps (Loop 2) — see `## User Experience & Value` below.

## Market context (2026)

Braintrust is the clearest reference for "close the loop": production trace → eval/dataset → regression gate → back into detection, explicitly marketed as turning every production trace into a test case and catching regressions before users do ([Braintrust vs Phoenix](https://www.braintrust.dev/articles/arize-phoenix-vs-braintrust); [MLflow 2026 observability roundup](https://mlflow.org/top-5-agent-observability-tools/); [Braintrust articles](https://www.braintrust.dev/articles)). Arize Phoenix stays observability-first (OTel-native, LLM-as-judge scoring) and leaves feedback→detector retraining to the user. LangSmith is ecosystem-coupled (LangChain/LangGraph) rather than loop-first. **Takeaway: closing this loop is a market differentiator, not table stakes yet.**

Lemma's public site (uselemma.ai) documents an "Issue → suggested fix → post-fix online eval that re-scores every new trace → Reopened if it regresses" pipeline that is functionally the same shape as eden's own shadow-detector lifecycle (`_scout_novel_patterns` → promote/delete via `evaluate_shadow_precision`) — the difference is Lemma's loop is fully wired end-to-end and eden's has the same pieces sitting disconnected. Full Lemma feature detail, terminology verification, and sourcing lives in `features/15-artifacts-behavior-record.md` and `features/16-issue-extraction-online-evals.md`; not re-derived here.

## Correction from the prior pass: which migration system is actually live

The prior pass cited `migrations/036_nl_signals.sql` as the `nl_signals` schema source. That file exists and matches the live schema, but **it is not the migration system that actually runs**. `src/eden/db_migrations/runner.py:1` — docstring "Run Alembic migrations at API boot (Northflank / Docker)" — confirms the production migration path is the Alembic-style chain under `src/eden/db_migrations/versions/`, currently 150 files, most recent `142_session_summaries.py` (`revision = "142_session_summaries"`, `down_revision = "141_ci_eval_run_metadata"`). The `nl_signals` table's *live* migration is `src/eden/db_migrations/versions/090_nl_signals.py` (`revision = "090"`, `down_revision = "089"`), which wraps the identical `CREATE TABLE nl_signals (...)` SQL from the legacy file in `op.execute(...)` calls. **Any new migration for this feature must be added under `src/eden/db_migrations/versions/`, not the top-level `migrations/` directory** — that directory appears to be a pre-Alembic or staging artifact that is no longer executed at boot. This matters concretely: a naive engineer following the prior pass's citation would add a migration file that the app never runs.

The `nl_signals`/`agent_id` column precedent for the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` idiom already exists in the live chain — `src/eden/db_migrations/versions/097_signal_definitions_f35_bridge.py:37-39` does exactly this pattern against a sibling table (`signal_definitions`, columns `template_id`, `statgate_rule`, `investigator_prompt`), confirming the idiom to copy.

## Loop 1 — eden's current state on the shadow-detector confirm/dismiss loop (every component re-verified this pass, line numbers corrected where they shifted)

**1. Nightly novelty scout.** `SoftIssueReviewer._scout_novel_patterns()` (`src/eden/services/soft_issue_review.py:248`), driven by `run_once()` (`:56`, not `:171` as previously cited — the class's methods were re-outlined this pass: `run_once` is the second method in the class body, at `:56`), scheduled nightly at 03:30 UTC (`src/eden/workers/cron_tick.py:409-420`). Per hot agent (`_hot_agents`, `:119-135` — confirmed this pass to read directly from `agent_issues.agent_id`, `GROUP BY agent_id ORDER BY COUNT(*) DESC`, no join to any agent-registry table), it samples failing traces (`_sample_traces`, `:200-`) and proposes new detector text.

**2. New detectors land as shadow (disabled) `nl_signals` rows, org-scoped only.** The insert happens inside `_create_shadow_detector` (`soft_issue_review.py:333-335`, signature `async def _create_shadow_detector(self, pg, org_id, agent_id: str, description: str)`), columns `(id, org_id, description, rule, enabled, created_by, cluster_id)`, `enabled=FALSE` (`:357-360`). The agent is smuggled into free text: `f"[auto:{agent_id}] {description}"` (`:363`, confirmed exact string this pass). **Confirmed this pass: `nl_signals` genuinely has no `agent_id` column anywhere in the live schema** — `src/eden/db_migrations/versions/090_nl_signals.py` (the live migration, see correction above) matches the legacy file's column list exactly (`id, org_id, description, rule, enabled, created_by, cluster_id, last_matched_at, match_count, created_at, updated_at`).

**3. Confirm/dismiss counters exist but have exactly one writer, and it's never called.** `record_shadow_feedback(org_id, signal_id, *, confirm=None, dismiss=None)` (`soft_issue_review.py:571-618`) writes into `rule.operator_confirms`/`rule.operator_dismisses` via a nested `jsonb_set` (`:589-609`). Confirmed zero production callers this pass (grep, only its own `def` and internal logging match). `evaluate_shadow_precision` (`:510-568`) is the sole reader of those two keys (`:529-537`).

**4. Weekly promote/delete job runs off those (permanently empty) counters.** `promote_shadow_detectors()` (`:380-`) queries `SELECT id, org_id, description, rule, match_count, cluster_id FROM nl_signals WHERE enabled = FALSE AND cluster_id LIKE 'auto:%' ORDER BY created_at ASC LIMIT 200` (`:402-410`) — note the promote job's own dedupe marker (`cluster_id LIKE 'auto:%'`) is a *different* "auto" tag than the description's `[auto:{agent_id}]` prefix; they serve different purposes (one flags scout-originated rows for this query, the other encodes which agent a row is about) and must not be conflated when adding the `agent_id` column below. Per row it calls `evaluate_shadow_precision(r, min_firings=min_firings, promote_precision=promote_p, delete_precision=delete_p)` at `:423`, then only consumes `decision["action"]` (`:429`) to promote/delete — `decision["precision"]` and `decision["firings"]` are used exactly once, at `:447-448`, purely as arguments to the Slack notifier `_notify_shadow_promoted` (`:444-450`). **Confirmed this pass: no code path anywhere touches `decision["precision"]` for anything other than a notification string.** Since `operator_confirms`/`operator_dismisses` are always zero (point 3), `evaluate_shadow_precision` always takes the `labeled == 0` branch (`:550-554`) — `precision = None`, and the promote path (which requires `precision is not None` at `:557`) can never fire.

**5. `resolve_issue` — confirmed live, confirmed not wired, line numbers corrected this pass.** `POST /orgs/{org_id}/agent-issues/{issue_id}/resolve` → `resolve_issue` (`src/eden/api/routes/agent_issues.py:167-`). The prior pass cited the `resolved`-gate at `:179` and the two `_repo.get_issue` calls at `:187`/`:206`; re-verification this pass finds they shifted by 1–3 lines (the function body did not change, but something above it in the file did): the gate is now `if ok and target == "resolved":` at **`:180`**, and there are in fact **two separate, redundant `_repo.get_issue(org_id, issue_id)` calls inside the same request**, not one each in two side-effect blocks as previously implied — `:190` (inside the `RegressionRunner` try-block, its result used only for `issue.agent_id` at `:191`) and `:209` (inside the flywheel try-block). Both re-fetch the identical row. The portal calls this endpoint directly (`clients/portal/src/lib/api/resources.ts:2755`).
   - On `status == "resolved"`: `on_issue_resolved` regression-case builder (`:182-186`), `RegressionRunner().run_suite(...)` (`:188-197`), `IssuePromptEvolver().evolve_from_issue(...)` (`:199-204`), flywheel coordinator `on_issue_resolved(...)` (`:207-223`).
   - On `status == "ignored"`: nothing. No `elif` branch exists; `ignored` only flips the status column via `_repo.set_status` at `:174-176`.

**6. The `signal_id` join — corrected and simplified this pass.** `_maybe_write_stumble` (`src/eden/signals/investigator.py`) writes `detail={"signal_id": str(row["id"]), ...}` at **`:389`** (re-verified; within the previously-cited `:357-395` range) and tags `detected_by="signal_investigator"` at `:394`. `IssuePromoter._insert` (`src/eden/issues/issue_promoter.py:69`, the `INSERT INTO agent_issues` statement at `:81`) does not carry `detail` onto the `agent_issues` row — confirmed again this pass, same column list as before. The only surviving link is `example_stumble_ids`.
   - **New this pass, and it materially simplifies the plan: `IssuesRepo.get_stumble(org_id, stumble_id)` already exists** (`src/eden/issues/repo.py:193-206`) — `SELECT * FROM agent_stumbles WHERE org_id = $1 AND id = $2::uuid`, returns `dict[str, Any] | None`. The prior pass flagged this as "add if not present"; it is present, with exactly one existing caller (`agent_issues.py:311`, the standalone `GET .../stumbles/{stumble_id}` route). **No new repo method is needed for P0-A.**
   - **New bug found this pass, not present in the prior draft: `detail` comes back as a raw JSON string, not a dict.** `agent_stumbles.detail` is `JSONB NOT NULL DEFAULT '{}'::jsonb` (`src/eden/db_migrations/versions/084_agent_issues.py:54`). The generic row fetcher, `PostgresClient.fetchrow` (`src/eden/storage/postgres.py:839-847`), does a bare `dict(row) if row else None` — confirmed zero `set_type_codec` registrations anywhere in `postgres.py` (grep), consistent with the file's pervasive explicit `json.loads(row["field"])` pattern elsewhere (8+ call sites, e.g. `:1289`, `:1363`, `:1542`). So `stumble["detail"]` is a JSON-encoded `str`. The prior pass's sketch, `(stumble.get("detail") or {}).get("signal_id")`, would raise `AttributeError: 'str' object has no attribute 'get'` on the very first real stumble it processed. Confirming this isn't just a hypothetical: the *existing* caller of `get_stumble`, `_serialize_stumble` (`agent_issues.py:271-278`), also does not `json.loads` the field — it passes `detail` through as-is with only datetime/UUID coercion, so any downstream portal code treating that endpoint's `detail` as a parsed object is already exposed to the same latent bug independent of this feature.
   - `detected_by` values confirmed **not** to be shadow-detector-originated (must not trigger `record_shadow_feedback`): `"sdk"`, `"layer_a"`, `"agent_session"`, `"auto_scanner"`. Only `"signal_investigator"` qualifies.

**7. Detection thresholds are static.** `detection_settings.py`: `_DEFAULT_PROFILE = "standard"` (`:23`), `_CACHE_TTL_S = 30.0` (`:24`), `_cache: dict[str, tuple[float, dict[str, Any]]] = {}` (`:27`), `VALID_PROFILES = ("minimal", "standard", "advanced")` (`:22`). `resolve_profile(org_id: str) -> str` (`:115-119`) — org-scoped only, single positional arg. Full signature analysis in its own section below (Task 2).

**8–10.** Unchanged from prior pass (behavior-record fragmentation across `PromptService`/`TriageAgent`/`playbook_router`/`IssuePromptEvolver`; no MCP confirm/dismiss tool; F21 as the one fully-wired label→retrain loop, `tool_call_inference_v1` default `False`, `config.py:1229`). Not re-verified line-by-line again this pass since nothing in this pass's research touched them; see prior pass content for citations.

## Task 1 — the actual migration and code diff

### (a) `nl_signals.agent_id` — migration file, exact SQL, backfill strategy

**New file:** `src/eden/db_migrations/versions/143_nl_signals_agent_id.py` (next number after `142_session_summaries`; the top-level `migrations/044_users_text_fk.sql` chain is the dead legacy system per the correction above and must not be used).

```python
"""143: nl_signals.agent_id — real column instead of description prefix.

revision: str = "143_nl_signals_agent_id"
down_revision: str | Sequence[str] | None = "142_session_summaries"
"""

def upgrade() -> None:
    op.execute(
        "ALTER TABLE nl_signals "
        "ADD COLUMN IF NOT EXISTS agent_id VARCHAR(256)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_nl_signals_org_agent "
        "ON nl_signals (org_id, agent_id) WHERE agent_id IS NOT NULL"
    )
    # Backfill from the "[auto:{agent_id}] " prefix _create_shadow_detector
    # has always written into `description` (soft_issue_review.py:363).
    op.execute(
        r"""
        UPDATE nl_signals
        SET agent_id = substring(description FROM '^\[auto:([^\]]+)\]')
        WHERE agent_id IS NULL
          AND description ~ '^\[auto:[^\]]+\]'
        """
    )

def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_nl_signals_org_agent")
    op.execute("ALTER TABLE nl_signals DROP COLUMN IF EXISTS agent_id")
```

Column type: `VARCHAR(256)`, not `UUID`. This corrects the prior pass, which suggested `agent_id UUID`. Verified this pass: `agent_issues.agent_id` and `agent_stumbles.agent_id` are both `VARCHAR(256)` (`src/eden/db_migrations/versions/084_agent_issues.py:49,93`), and no `agent_registrations` table exists anywhere in the live `db_migrations/versions/` chain (grep for the table name returns zero migration files) — `agent_id` is a free-form, unvalidated string throughout the codebase, not a UUID and not FK-able to anything today. `nl_signals.agent_id` must match that convention exactly, with no `REFERENCES`.

**Can the `[auto:{agent_id}] ` prefix be reliably parsed?** Yes in practice, not by construction. The regex `^\[auto:([^\]]+)\]` fails only if a production `agent_id` itself contains a `]` character. No format validator for `agent_id` exists anywhere in `src/eden` (grep for `agent_id` near `regex|pattern|validate` returns no hits outside unrelated code) — so this is a real, if low-probability, assumption. Two mitigations, both worth doing before relying on the backfill in production: (1) run a post-backfill sanity check, `SELECT count(*) FROM nl_signals WHERE description LIKE '[auto:%' AND agent_id IS NULL` — any non-zero result identifies exactly which rows failed to parse and why; (2) going forward, stop depending on the prefix at all — `_create_shadow_detector` should insert `agent_id` as a first-class column immediately:

```python
# soft_issue_review.py:333-366, _create_shadow_detector — add agent_id to the INSERT
await pg.execute(
    """
    INSERT INTO nl_signals
        (id, org_id, agent_id, description, rule, enabled, created_by, cluster_id)
    VALUES ($1, $2, $3, $4, $5::jsonb, FALSE, NULL, $6)
    """,
    str(uuid.uuid4()),
    org_id,
    agent_id,
    f"[auto:{agent_id}] {description}",  # keep the prefix one release cycle for
                                          # any code/dashboards still parsing it;
                                          # drop in a follow-up migration once
                                          # nothing reads it.
    json.dumps(rule.to_dict()),
    cluster_id,
)
```

And `promote_shadow_detectors`'s SELECT (`:402-410`) needs `agent_id` added to its column list so a future per-agent rollup (Task 2) can group by it without a second query:

```sql
SELECT id, org_id, agent_id, description, rule, match_count, cluster_id
FROM nl_signals
WHERE enabled = FALSE AND cluster_id LIKE 'auto:%'
ORDER BY created_at ASC LIMIT 200
```

### (b) The exact join for `signal_id`, corrected for the JSON-string bug

```python
# agent_issues.py, extending the block that starts "if ok and target == "resolved":" at :180
if ok and target in ("resolved", "ignored"):
    issue = await _repo.get_issue(org_id, issue_id)  # already fetched at :190/:209
                                                       # on the "resolved" path — reuse
                                                       # rather than adding a 3rd fetch;
                                                       # "ignored" needs its own fetch since
                                                       # none of those blocks run for it.
    if issue and issue.example_stumble_ids:
        stumble = await _repo.get_stumble(org_id, issue.example_stumble_ids[0])  # repo.py:193, already exists
        if stumble and stumble.get("detected_by") == "signal_investigator":
            detail = stumble.get("detail") or "{}"
            if isinstance(detail, str):        # JSONB round-trips as str — see finding 6
                import json
                detail = json.loads(detail) or {}
            signal_id = detail.get("signal_id")
            if signal_id:
                from eden.services.soft_issue_review import record_shadow_feedback
                await record_shadow_feedback(
                    org_id, signal_id,
                    confirm=(target == "resolved") or None,
                    dismiss=(target == "ignored") or None,
                )
```

No new `IssuesRepo` method required (correction from prior pass). The only genuinely new plumbing is the `isinstance(detail, str)` guard, the `target in (...)` gate change, and the call itself.

### (c) The exact call to invoke `record_shadow_feedback`

Given above, inline within (b) — this is intentionally not a separate call site; `record_shadow_feedback(org_id, signal_id, confirm=..., dismiss=...)` (`soft_issue_review.py:571-618`) is called once per resolve/dismiss action, immediately after the join resolves a `signal_id`. `record_shadow_feedback` itself needs no changes — its signature already matches.

**P0-C (dismiss-window auto-disable) and P0-D (MCP tool) are unchanged from the prior pass** — `confirm_shadow_detector(org_id, signal_id, confirm|dismiss)` calling `record_shadow_feedback` directly, since `mcp_server/tools.py` still has zero confirm/dismiss/shadow-feedback matches (re-grepped this pass, same result).

## Task 2 — what happens to `evaluate_shadow_precision`'s output, and whether `resolve_profile()` needs a signature change

**Short answer: yes, `resolve_profile()` needs both a signature change and a new schema, and — more importantly — a wholly new aggregation function that does not exist today.** `evaluate_shadow_precision`'s output is not "per-agent precision data" in any form `resolve_profile` could consume even with a parameter added; it's a per-*detector* decision, and nothing rolls that up.

**Trace of the current (non-)pipeline, confirmed this pass:**
1. `evaluate_shadow_precision(row, ...)` (`soft_issue_review.py:510-568`) runs once per `nl_signals` row inside `promote_shadow_detectors`'s loop (`:420-`), called at `:423`. Its return, `{"action": "promote"|"delete"|"hold", "precision": float | None, "firings": int, "confirms": int, "dismisses": int}`, describes *one shadow detector's* confirm/dismiss track record — not an agent, not an org.
2. The loop consumes `decision["action"]` (`:429`) to enable/delete that one row. `decision["precision"]` and `decision["firings"]` are read exactly twice more, both at `:447-448`, and both go straight into `_notify_shadow_promoted(...)` (`:444-450`) — a Slack message. **Confirmed by grep (`decision[` matches only `:429`, `:447`, `:448`): nothing else in the codebase reads this dict.** There is no aggregation step, no per-agent grouping, no write to `detection_settings` or `organizations.settings` anywhere downstream of `evaluate_shadow_precision`.
3. `resolve_profile(org_id: str) -> str` (`detection_settings.py:115-119`) reads `get_detection_settings(org_id)` (`:44-69`, TTL-cached 30s, `_cache` keyed by the bare `org_id` string) and returns one of exactly three categorical values, `VALID_PROFILES = ("minimal", "standard", "advanced")` (`:22`) — not a numeric threshold. Storage is `organizations.settings->'detection'` (a single JSONB blob on the `organizations` row, read/written by `get_detection_settings`/`set_detection_settings`), entirely org-scoped; there is no per-agent column, table, or JSONB key anywhere in this file.
4. `resolve_profile`'s **only production caller** is `_resolve_profile` in `src/eden/workers/trace_finalized_consumer.py:634-644`, itself called at `:317` as `detection_profile=await _resolve_profile(org_id)`, as one keyword argument to `self._scanner.scan(org_id, trace_id, agent_id=data.get("agent_id") or None, session_id=..., user_id=..., detection_profile=await _resolve_profile(org_id))`. **The `agent_id` this call would need is already sitting in the same call's kwargs, two lines above** (`data.get("agent_id")` at `:314`) — so threading a per-agent value through the one real call site is genuinely trivial once the function itself supports it.

**What actually needs to change, precisely:**

- **A new aggregation function**, e.g. `compute_agent_precision_profile(org_id: str, agent_id: str) -> str | None`, that: groups `nl_signals` rows `WHERE org_id = $1 AND agent_id = $2` (now possible once Task 1(a)'s column exists), runs `evaluate_shadow_precision` per row, and rolls the per-row `precision`/`firings` up into a single score (e.g. firings-weighted mean precision across rows with `precision is not None`), then maps that score into one of the three `VALID_PROFILES` buckets via new, undefined-today thresholds (e.g. `>= 0.8` weighted precision with `>= 3` labeled detectors → `"advanced"`; `< 0.3` or heavy dismiss rate → `"minimal"`; else `"standard"`). None of this mapping logic exists anywhere in the codebase — confirmed by the same grep that shows `VALID_PROFILES` is referenced only in `detection_settings.py` and the one read site in `trace_finalized_consumer.py`.
- **A new storage layer for the per-agent override**, not a bigger `organizations.settings` blob. `organizations` is a shared, frequently-touched row (SSO, 2FA, domain restrictions, billing, RBAC per migrations `007`–`014`); cramming a growing `agent_overrides` map for every hot agent into the same JSONB column risks write contention and unbounded row growth on exactly the table every org-level settings read/write already hits. A dedicated table mirrors how `nl_signals` itself is separate from `organizations`: `agent_detection_overrides(org_id, agent_id, detection_profile, source, updated_at, PRIMARY KEY (org_id, agent_id))`.
- **`resolve_profile`'s signature becomes** `async def resolve_profile(org_id: str, agent_id: str | None = None) -> str` — backward compatible for every other caller (there are none besides the one above, so this is low-risk), falling back to the existing org-level result when `agent_id` is `None` or has no override row.
- **The cache breaks as currently typed.** `_cache: dict[str, tuple[float, dict[str, Any]]]` (`:27`) is keyed by a bare `str` (org_id). Adding an agent dimension needs either a second cache dict (`_agent_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]]`) or widening the existing key to `tuple[str, str | None]` — the latter is cleaner but touches every read of `_cache[org_id]` in `get_detection_settings`, not just `resolve_profile`.
- **The scheduled job to populate the override table** can piggyback the existing weekly slot (`cron_tick.py:566-569`, where `promote_shadow_detectors` already runs) rather than needing a new cron entry — after `promote_shadow_detectors` finishes its per-row promote/delete pass, a follow-up step groups the same rows by `agent_id` and calls `compute_agent_precision_profile` per agent, upserting into `agent_detection_overrides`.

None of the above exists today. This is not a wiring gap like Task 1 — it's a small, well-scoped **new feature** (new table, new function, one signature change, one cache-key change), correctly sequenced behind Task 1(a) since it has no data to aggregate until `nl_signals.agent_id` exists.

## Behavior record — design sketch (depends on Part 0.2, agent_id mandatory)

Unchanged from the prior pass's join sketch, with one addition: once Task 1(a) lands, the `nl_signals` join in that sketch stops being a string-match (`WHERE description LIKE '[auto:'||agent_id||']%'`) and becomes `JOIN nl_signals ON nl_signals.agent_id = agent_id` — a real, indexed join via `idx_nl_signals_org_agent`. Full detail (`features/15-artifacts-behavior-record.md` covers the persistent-record product shape Lemma calls "Artifacts"; this doc's join sketch is the substrate that would feed it, not the product design itself).

## Loop 2 — eden's autonomous issue → patch → test → auto-merge → auto-revert loop (`src/eden/improvement/`)

**New in this pass; the single most consequential documentation gap this doc had.** `src/eden/improvement/` (`planner.py`, `auto_merge.py`, `guardian.py`, `test_gate.py`, `agent.py`, `issue_patch_trigger.py`, `replay_verify.py`, plus `approve.py`/`plans_repo.py`) is ~9,800 lines across 15 files — a second, structurally separate closed loop, sharing no code paths with Loop 1 (no cross-imports found via grep). It is complementary to Loop 1, not overlapping: Loop 1 learns what counts as an issue; `improvement/` autonomously fixes issues once confirmed.

**The mechanism, end to end:** an issue clusters from production failures → `PatchGenerator` drafts a `code_patch` plan → a human (or, on a narrow canary ladder, eden itself) approves it → a PR opens and merges → a post-merge verify check runs → if it fails, `guardian.py` decides between drafting a revert or a follow-up fix, and on a specific class of merges can execute the revert itself. Every step from patch generation to merge to revert can be autonomous — gated by a five-tier action ladder, not a single trust switch.

**The autonomy ladder** (`src/eden/closed_loop/autonomy_policy.py:49-73`, `_ACTION_TIERS`, "T0 observe" → "T4 auto-merge"):
- **T0/T1 (observe)** — alert, recommend, investigate, triage. Always allowed; `decide()` returns `"allow"` unconditionally for tier ≤ 1 (`:232-233`).
- **T2 (reversible)** — `rollback`, `reweight`, `cache_bust`, `self_heal` (bucketed under `auto_runtime_heal`). Defaults **on** (`AutonomousMaintenancePolicy`, `:76-92`: `auto_runtime_heal: bool = True`).
- **T3** — prompt canaries, nudge/guardrail promotion.
- **T4 (highest blast radius)** — `code_patch_merge`/`auto_merge`, gated on `auto_code_patch_pr` and `auto_code_patch_merge`, both defaulting **off** (`False`).
- HIPAA orgs are pinned to `"observe"` regardless of stored mode — a hard compliance override, not a UI-overridable setting (`:94-98`, `effective_mode`).

The defaults are deliberately asymmetric: reversible actions execute by default, and both patch-PR and patch-merge are explicit per-org opt-ins. `"assisted"` mode (the default, between `observe` and `autonomous`) makes `decide()` return `"require_approval"` for `auto_code_patch_pr`/`auto_code_patch_merge`/`auto_nudge_promote` *before* the fine-grained per-flag check even runs (`:250-256`) — drafting a plan has no repo side effect, so a human Approve is the real gate regardless of what the finer-grained flag says.

**Guardrails that make the ladder more than a config flag:**
- `evaluate_auto_merge_eligibility` (`auto_merge.py:385-526`) is a linear, all-must-pass gate with per-gate machine-readable rejection reasons: `feature_killed:auto_merge`, `compliance:{profile}`, `evidence_tier:{tier|missing}`, `diff_over_soft_cap:{lines}>{soft}` (default 200, `patch_max_diff_lines_soft`), `kg_revert_history` (a file the org has had to revert before doesn't get to ride the auto-merge lane again, `_kg_has_revert_history`), `weekly_cap:{used}>={cap}` (default 2/org, org-overridable, enforced via an atomic `pg_advisory_xact_lock`-backed slot claim, `claim_auto_merge_slot`, closing a TOCTOU race between concurrent approvals), and `auto_merge_blocked:branch_protection` (fail-closed: no protection-check hook on the provider means "assume blocked," not "assume allowed"). `soc2_strict`/HIPAA orgs are excluded from the eligible tiers entirely.
- `guardian.handle_regression` (`improvement/guardian.py:118-231`), triggered from exactly one place — `_on_verify_failed` in `closed_loop/orchestrator.py:271-296` — looks up the merged plan responsible and bails cleanly (`{"status": "no_plan"}`) if the regression wasn't caused by an eden PR at all; checks for an already-open follow-up first so a flapping regression can't spam duplicate drafts; decides revert vs. follow-up by severity (`_REVERT_SEVERITIES = {"P0","P1","CRITICAL","HIGH"}`) gated by the org's rollback policy; and builds a **real inverted diff** (`invert_unified_diff` on the parent's merged diff), applied statically against current HEAD, only kept if that apply passes — drift or a static-apply failure falls back to a follow-up fix with the specific conflict reason recorded (`revert_conflict`) rather than fabricating a clean revert against a codebase that's moved on.
- Auto-execution of the revert itself is narrower than "canary org, therefore auto-revert": `_maybe_auto_execute_revert` (`:234-298`) only proceeds when the *parent* PR is stamped `canary: true` AND `merged: true` (a missing key is treated as **not** canary — an explicit "avoids accidental auto-revert on non-canary merges" comment), `auto_revert_permitted` passes its own independent check, and `auto_code_patch_merge` is enabled. The overwhelming majority of merges are approved manually and never touch this path. The auto-revert path reuses `approve_plan` with `approved_by="eden:guardian_auto_revert"` — a distinguishable synthetic actor, not a spoofed human name — and only genuine revert/auto-revert actions write knowledge-graph `"reverted"` history, specifically to avoid follow-up drafts inflating `kg_revert_history` and falsely blocking future auto-merges on unrelated files.
- `test_gate.py` is built to never lie about what ran: environment failures (`ImportError`, `ModuleNotFoundError`, npm "Cannot find module", Go "cannot find package," etc.) are routed to `skipped:env_unavailable`/`skipped:no_tests_collected`/`skipped:timeout`, never `status="failed"` (`interpret_sandbox_result`, `:340-379`) — a green result means the patch was actually exercised, not "the harness happened to not crash." A patch cannot rewrite the tests meant to catch it: the discovered-test-file set explicitly excludes files the patch itself touches (`:434-440`, `patch_touches_tests` skip). LLM-synthesized tests are default **off** (`test_gate_synthesis_v1`) — the module docstring states plainly that "LLM-authored tests in customer PRs are a trust risk until dogfood review" (`:16-19`); when on, synthesis is Python-only, capped at one LLM call via a shared budget, and mandates network isolation for the executed test (`require_isolation=synthesized`, `:353-354`) so eden is never both generating and judging code unisolated.
- Rollout gate for the scariest capability, stated candidly in `auto_merge.py`'s own module docstring (`:1-5`): "DARK by default: requires N22 T4... stays process-gated until dogfood proves 5 consecutive auto-merges with zero guardian regressions" before it's offered to customers — a genuinely trust-appropriate bar, not just an internal flag.

This is, structurally, a well-designed set of guardrails for the highest-blast-radius action in the product — the gaps that remain are in what the UI surfaces about the mechanism's own reasoning, not in the mechanism itself (see `## User Experience & Value` below).

## A third related mechanism: `EvidenceGate`/prompt-canary promotion, and where `nudges/` fits

Eden has built the shape "shadow candidate → statistical gate → promote/demote" a third time, via `EvidenceGate` (`src/eden/promotion/evidence_gate.py`), which backs `PromotionLoop` (`src/eden/llmops/promotion.py`) — the autonomous prompt-canary promotion mechanism — and the manual promote route (`api/routes/prompt_canary.py`). `EvidenceGate` declares six `PromotionKind`s (`pr_merge`, `prompt_version`, `guardrail`, `model_routing`, `kb_skill`, `nudge`), but **only `"nudge"` is structurally capable of promoting today**, for two independent, unrelated reasons:

- **A type mismatch.** `PromotionLoop._evidence_gate_promote` (`llmops/promotion.py:343-367`) enqueues `ref_id=f"{agent}:{candidate_version}"` — a composite string like `"checkout-agent:7"` — into `promotion_candidates.ref_id`, a column declared `UUID NOT NULL` (`db_migrations/versions/092_market_ready_consolidated.py:195`). The `INSERT` always raises (asyncpg's UUID codec rejects a non-hex string), caught by a bare `except Exception: return None` in `EvidenceGate.enqueue` (`evidence_gate.py:70-72`) — so `_evidence_gate_promote` always returns `False` and prompt-canary promotion can never reach `"promote"` via this path. This is 100%-reproducible, not probabilistic. The manual-promote API route has the identical bug and surfaces it as an explicit error (`prompt_canary.py:191-201`, `HTTPException(503, "EvidenceGate enqueue failed — promote blocked")`), but nothing in the codebase or tests currently trips it.
- **A hardcoded kind-gate**, independent of the type bug: `EvidenceGate._metrics_from_outcomes` (`evidence_gate.py:114-122`) hardcodes `if kind != "nudge" or not ref_id: return []` — so `prompt_version` (and `guardrail`, `model_routing`, `kb_skill`) always see an empty evidence set regardless of `ref_id`, and `evaluate()`/`evaluate_bayesian()` always return `passed=False, recommendation="hold"` for those kinds, permanently. Even fixing the UUID mismatch would not unblock promotion.

**`nudges/`** (`engine.py`, `author.py`, `shadow_outcomes.py`, `demotion_worker.py`) is the one working precedent that proves this loop's shape works in production: `nudges/author.py` and `api/routes/learn.py` call `enqueue(..., kind="nudge", ref_id=<real nudge UUID>)`, which `_metrics_from_outcomes` explicitly handles via a real join to `nudge_outcomes`/`nudges` (`evidence_gate.py:129-144`), and `NudgeEngine.set_mode` is genuinely called from `EvidenceGate.promote_if_passed`/`demote` (`:295,344`). This is worth citing as a template when wiring Loop 1's P0 fixes above, since it's the only one of eden's three shadow→promote mechanisms that currently promotes anything end-to-end — and the opposite UX gap from Loop 2: `nudges/`'s lifecycle has **zero portal surface** (a case-insensitive grep for "nudge" across `clients/portal/src/**/*.{ts,tsx}`, excluding tests, returns no matches outside type definitions in `lib/api/resources.ts`), whereas `improvement/` has a real, actively-used review UI (see below).

Net: eden has built this "shadow → gate → promote" shape at least three times (`nl_signals`, `promotion_candidates`, and `nudges/`'s use of the same `EvidenceGate` machinery), and only the `nudges/` instance currently promotes anything — for three unrelated root causes (dead confirm/dismiss wiring here in Loop 1; a UUID type bug plus a hardcoded kind-gate in `EvidenceGate`; and, for `nudges/`, simply having been finished end-to-end). *(This mechanism is also the autonomous prompt-evolution/canary-promotion loop referenced from `features/03-prompt-playground.md`; that doc covers the prompt-playground product surface, this doc owns the promotion-mechanism verification above.)*

## User Experience & Value

**Who this is for:** an ML/platform engineer or on-call operator running eden day-to-day — the person who already triages `agent_issues` in the portal, sets autonomy budgets, and decides whether to let eden merge or revert its own code.

### Loop 1 (shadow-detector loop): invisible and inert today
- The nightly scout silently proposes new shadow detectors (`nl_signals` rows, `enabled=FALSE`) with no portal surface distinguishing them from confirmed detectors — there is no "N new candidate detectors waiting for review" page.
- `resolve_issue`/`ignore_issue` — actions an operator already takes constantly in the issues UI — have zero effect on detector quality today, even though the human labeling effort they represent (an implicit confirm/dismiss) already happens for free. Wiring P0-A/P0-B (Task 1 above) doesn't ask users to do anything new; it just stops discarding a signal they're already producing.
- The weekly `promote_shadow_detectors` job runs on schedule and does nothing meaningful — a real cron job silently evaluating a `precision=None` no-op every week. Nothing an operator would notice is broken; this is a "confidently doing nothing" failure mode that looks green in monitoring, the most dangerous kind.
- Once wired, detection quality improves as a side effect of normal issue triage, with no new screen for the operator to learn — a real adoption advantage once the P0 items land.

### Loop 2 (`improvement/`): a real, if incompletely surfaced, review product
Unlike Loop 1, `improvement/` has a live portal surface an operator actually uses today:
- **`autonomy-settings-card.tsx`** (`clients/portal/src/lab/settings/`) is a real settings panel, not a mockup — a single toggle for `auto_runtime_heal` with copy stating the concrete consequence of turning it on ("Reversible actions only · max {N} rollbacks/day") and off ("Eden will recommend heals instead of executing them"), plus `compliance_profile` (when non-standard) and the day's budget spend inline.
- **`autonomy-audit-card.tsx`** is a read-only allow/deny ledger — "Recent allow/deny decisions for runtime heals and maintenance actions," patches-used-today/max-per-day, and a suppressed-decision count ("N budget denials today"). This is the primitive that turns "a black box that sometimes acts" into "a system whose restraint is visible": an operator can see not just what eden did but what it refused to do, and why (budget exhaustion, specifically).
- **`autonomy-roi-banner.tsx`** is the counterfactual-value surface: when self-heal is off, it renders "Eden would have fixed {N} reversible heals in the last 7 days" with a direct link to turn it on; when budget is exhausted it separately flags "Maintenance budget exhausted today" with a link to the audit. Concrete, dated cost of *not* trusting the loop, without ever forcing the toggle — and it fails soft (renders nothing) on a query error rather than showing a broken counter.
- **`/improve` (`app/(portal)/improve/page.tsx`) and `/improve/plans/[id]`** are a real, coherent plan-review screen, not two disconnected prototypes: the diff (`DiffPane`, unified diff or a before/after split when none exists), the RCA/"why" text, regression-follow-up provenance when a plan is a guardian-drafted revert or follow-up (explicit "Eden's post-merge guardian drafted this after the original fix regressed" copy with a link to the original plan — a concrete answer to "how do I see why something got auto-reverted" that doesn't require reconstructing timestamps), evidence chips (evidence tier, static-check status, sandbox test status with an explicit "(synthesized)" suffix when the test was LLM-authored, CI status, severity, confidence — with an honest empty state, "No evidence attached — this plan was created without a failure pack or verification run," rather than a silently blank section), and a **"Preview impact"** button wired to `POST /orgs/{org}/change-impact/preview` that replays the change against production traffic and returns `traces_replayed`, `trajectory_divergence_rate`, `new_predicted_stumbles`, cost/latency delta, and a colored recommendation — arguably the single strongest trust-building mechanic in the whole loop, since it lets a reviewer see predicted blast radius before clicking Approve rather than trusting the diff's plausibility alone.

### Concrete usability/adoption gaps found this pass
1. **Reject reason is captured by the backend but discarded by the live UI.** `POST /plans/{plan_id}/reject` accepts a `reason` and classifies it (`"user_fixed"` if the text mentions already-fixed, `"outdated"`, else `"wontfix"`), driving a different re-propose dedupe TTL (90 days for `user_fixed` vs. 30 for the rest) via `write_rejection_memory`. The live call site (`app/(portal)/improve/page.tsx:300`) calls `rejectPlan(orgId, id)` with no reason, even though the client method already accepts an optional third argument (`lib/api/resources.ts:2976`), and the Reject button is a single click with a tooltip and no prompt/textarea. Every portal-originated rejection therefore falls into the generic 30-day `"wontfix"` bucket regardless of the real reason — the one place a reviewer could tell eden "I already fixed this, don't re-suggest it" and have that change eden's future behavior is unreachable from the UI a human reviewer actually uses. Small, high-leverage fix: add a reason prompt before calling `rejectPlan`.
2. **`AutoMergeDecision.reasons`/`blocked_by` is computed with real per-gate granularity but never rendered.** `plan-evidence-panel.tsx` reads `evidence.auto_merge` only for `ci_status`/`status` — a reviewer looking at a plan that didn't auto-merge has no UI-visible answer to "why not," only the raw evidence JSON if they go digging for it. This is the "why didn't this happen autonomously" half of the trust question the whole feature poses, and the data already exists — it's a rendering gap, not a backend gap.
3. **No real per-plan event log.** `plan-status-history.tsx` derives its timeline from mutable plan-status fields and says so in its own top-of-file comment ("the improve API has no event-history endpoint"); guardian decisions, sweep/re-approval attempts, and auto-merge re-evaluations aren't independently auditable — only approve/reject/snooze show up. For a feature whose entire value proposition rests on "you can see what eden did and why," a first-class append-only event log distinct from the mutable evidence blob is the single highest-leverage UX investment left in this loop.
4. **`nudges/`'s promote/demote lifecycle has no portal surface at all** (zero UI matches for "nudge" outside type definitions) — the opposite gap from `improvement/`, which has a real, built-out review UI. If `nudges/` and Loop 1's shadow-detector queue are ever reconciled into one confirm/dismiss surface, this gap is worth closing at the same time.
5. **The documentation gap was itself a real cost.** Through three prior passes, none of this doc, `15-artifacts-behavior-record.md`, or `16-issue-extraction-online-evals.md` covered `improvement/` at all — a mature, unusually well-designed-for-trust subsystem (graduated autonomy ladder, honest test reporting, replay-before-approve, conservative auto-revert) was invisible to anyone reading the strategic review until this pass.

### Why this matters
Eden's actual answer to "how do you trust an autonomous code-patch loop" is stronger than either this doc's prior silence on it, or a generic "flip a switch" pitch, would suggest: a graduated permission ladder that defaults reversible-on/everything-else-off with a hard compliance override; a review surface that shows evidence tier, honestly-labeled test results (including when synthesized), and a literal dry-run/replay of the change before Approve; an auto-merge ladder narrow enough to require a named internal dogfood bar (5 consecutive clean auto-merges) before it's even offered to customers; and a guardian that reverts conservatively — never fabricating a clean revert against a drifted codebase — and only self-executes on the one canary class whose original merge already proved itself. The gaps that remain (items 1–4 above) are narrow, fixable rendering/UI problems, not gaps in the underlying mechanism.

## Prioritized plan — updated with this pass's corrections

**P0-A — Recover `signal_id` at resolve time.** See Task 1(b)/(c) above for the exact diff. Simpler than previously estimated (`get_stumble` already exists); one new bug fixed in the process (JSON-string `detail`).

**P0-B — Wire the call for both outcomes.** Unchanged: extend the `:180` gate to `target in ("resolved", "ignored")` for the `record_shadow_feedback` call only; the four existing side effects stay `resolved`-only.

**P0-C — Make dismiss consequential independent of the weekly job.** Unchanged: after `record_shadow_feedback(..., dismiss=True)`, check `rule.operator_dismisses` inline; auto-disable on N dismissals within a window rather than waiting for the weekly batch.

**P0-D — Add the MCP tool + non-issue-flow confirm.** Unchanged.

**P1 — `nl_signals.agent_id` migration + backfill.** Now fully specified — see Task 1(a). This unblocks Task 2's aggregation function, which is itself now scoped as a small new feature (new table `agent_detection_overrides`, new function `compute_agent_precision_profile`, `resolve_profile(org_id, agent_id=None)` signature change, cache-key widening) rather than a one-line "feed precision into resolve_profile."

**P1 — Feed agent `purpose` into `_scout_novel_patterns`.** Unchanged, still blocked on Part 0.2.

**P1 — Trigger re-scout on prompt version changes.** Unchanged from prior pass (`prompt_name`/`agent_id` conflation caveat still applies, `prompt_versioning.py:223`, `components.py:772-774`).

**P2 — Generalize F21's pattern.** Unchanged (`config.py:1229`).

**Loop 2 (`improvement/`) UX fixes — new this pass, independent of the Loop 1 wiring above:**

**P1 — Capture the reject reason in the live `/improve` UI.** Add a reason prompt/textarea before the `rejectPlan(orgId, id, reason)` call (`app/(portal)/improve/page.tsx:300`); the backend classification and 90-day `user_fixed` dedupe bucket already exist end-to-end and are currently unreachable from the UI.

**P1 — Render `AutoMergeDecision.reasons`/`blocked_by` on the plan detail page.** The data already exists in `evidence.auto_merge`; this is a rendering gap in `plan-evidence-panel.tsx`, not a backend gap.

**P2 — A real per-plan event log.** Replace the derived-from-status-fields timeline (`plan-status-history.tsx`) with an append-only event log so guardian decisions, sweep attempts, and auto-merge re-evaluations are auditable independent of current status. Larger lift than the two P1s above (new endpoint + storage), but directly serves the feature's core trust claim.

## Why this order

Same as prior pass: P0 reuses code that exists and is now proven smaller than estimated (no new repo method, one bug fix). P1's `nl_signals.agent_id` migration is now fully specified and is a genuine prerequisite — not just for the "behavior record" join sketch, but for Task 2's aggregation function, which cannot exist without it. Task 2 itself is scoped this pass as a distinct, small *new feature* (table + function + signature change), not a config tweak — it should be estimated and possibly ticketed separately from the P0 wiring fix, which remains the single highest-leverage, lowest-risk item in the review.

The Loop 2 (`improvement/`) UX fixes above are independent of Loop 1's wiring plan — different subsystem, different team surface area — and can be sequenced in parallel. Within Loop 2 itself, the two P1s (reject-reason capture, `blocked_by` rendering) are pure UI fixes against already-existing backend data and should ship before the P2 event-log work, which needs new storage and an endpoint.

## Overlap check against 14-user-request-mining.md

Unchanged: minimal overlap. 14 is external market/competitor pain-point mining and does not discuss eden's shadow-detector feedback loop or the `improvement/` autonomous patch loop.

## Phase verdicts across all four passes

1. P0 — wire `record_shadow_feedback` into `resolve_issue` — **VERDICT: KEEP (high confidence), now fully specified.** Dead code confirmed a third time (`soft_issue_review.py:571`, zero callers). This pass found the wiring is smaller than the second pass estimated (`get_stumble` pre-exists) but also found a real bug the second pass's own sketch would have hit in production (`detail` JSON-string decoding) — both corrections are in Task 1(b)/(c) above.
2. P0 — make dismiss consequential — **VERDICT: KEEP (high confidence).** Unchanged; `:180` gate re-confirmed with no `ignored` branch.
3. P1 — feed agent `purpose` into `_scout_novel_patterns` — **VERDICT: KEEP-WITH-CAVEAT.** Unchanged, blocked on Part 0.2.
4. P1 — trigger re-scout on prompt version changes — **VERDICT: KEEP-WITH-CAVEAT.** Unchanged.
5. P2 — generalize F21's label→retrain pattern — **VERDICT: KEEP-WITH-CAVEAT.** Unchanged.
6. **New this pass:** "feed `evaluate_shadow_precision` into `resolve_profile`" (INDEX.md Part 0.1 step 2) — **VERDICT: RESCOPE.** This is not a wiring fix like the rest of P0/P1; it requires a new aggregation function, a new small table, and a `resolve_profile` signature + cache-key change. It should be tracked as its own scoped deliverable once P1's `nl_signals.agent_id` migration lands, not bundled into the P0 estimate. See Task 2 above for the full trace.
7. **New this pass (pass 4):** Document `improvement/` (Loop 2) in this doc at all — **VERDICT: KEEP (high confidence), now done.** Three passes of silence on eden's larger, more consequential autonomous patch loop was a real documentation-completeness gap, not a product gap — the mechanism itself is mature and well-designed for trust; see `## Loop 2` and `## User Experience & Value` above.
8. **New this pass (pass 4):** Capture reject reason in the live `/improve` UI — **VERDICT: KEEP (high confidence).** Backend classification and dedupe logic already exist; this is a UI-only fix.
9. **New this pass (pass 4):** Render `AutoMergeDecision.reasons`/`blocked_by` on the plan detail page — **VERDICT: KEEP (high confidence).** Data already exists in `evidence.auto_merge`; rendering gap only.
10. **New this pass (pass 4):** A real per-plan event log for `improvement/` — **VERDICT: KEEP-WITH-CAVEAT.** Larger lift than 8/9 (new endpoint + storage), but directly serves the feature's core "you can see what eden did and why" trust claim.
11. **New this pass (pass 4):** Cut the "Prior art: precision-gated confirm/dismiss loops outside AI" section — **VERDICT: CUT, done.** Generic, Wikipedia-tier academic framing that restated in textbook language a design (`min_firings`, promote/delete thresholds) already fully specified in Task 1/2; changed no engineering decision in three passes of review.

**Carried forward from pass 2, still true:** the weekly `promote_shadow_detectors` job (`soft_issue_review.py:380-`) is starved of usable input as a direct consequence of `record_shadow_feedback` never being called — confirmed again this pass via the same `decision["precision"]`/`decision["firings"]` grep that also confirmed those fields are otherwise unused. Wiring P0 unblocks this job's precision-based path for the first time.
