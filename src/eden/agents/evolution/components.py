"""Evolution components: JudgeScorePromptEvolver + PromptEvolvers.

Both classes live in this module so the Phase 7.2 closed-loop
flywire (judge scores → prompt variants → canary experiments) has
a single home.

The split between the two classes mirrors the test contract:

* :class:`JudgeScorePromptEvolver` is the *trigger* — it scans
  recent judge scores, finds degraded ``(agent, judge)`` pairs,
  and asks the LLM for a new prompt variant. The new variant is
  inserted via ``prompt_versions.insert_version`` with
  ``active=False`` and ``ab_test_active=True`` so it's eligible
  for canary enrollment.

* :class:`PromptEvolvers` is the *canary* — when a new variant is
  inserted, it enrolls the variant by writing
  ``prompt_canary_experiments`` (+ ``prompt_version_assignments``)
  at ``settings.evolver_auto_canary_pct`` traffic, merges canary
  metadata into ``quality_metrics``, and writes an
  ``evolver.auto_canary_created`` audit entry. Cockpit and
  PromotionLoop both read ``prompt_canary_experiments`` (not the
  legacy ``prompt_canaries`` table).

The two are deliberately decoupled so the canary stage can be
gated / opted-out via config (``evolver_auto_canary_pct=0``)
without touching the trigger.
"""

from __future__ import annotations

import contextlib
import json
import logging
from datetime import UTC
from typing import Any

from eden.kb.prompt_versions.client import get_prompt_versions_client
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


class _SettingsProxy:
    """Transparent proxy that delegates every attribute access to
    ``eden.config.get_settings()``.

    This lets two incompatible test patching strategies coexist:

    1. Tests that replace the module-level ``settings`` symbol —
       ``patch("eden.agents.evolution.components.settings")`` —
       keep working: the patch sets a new object on the module,
       and the methods read ``settings.<attr>`` which hits the
       patched value directly.

    2. Tests that mutate the live singleton via
       ``get_settings().evolver_max_variants_per_run = 1`` keep
       working: the conftest's ``patch_settings`` fixture
       replaces ``eden.config.get_settings`` with a stub that
       returns ``test_settings``. Our proxy re-imports
       ``get_settings`` on every attribute access, so the stub
       is used and the mutated value is picked up.
    """

    def __getattr__(self, name: str) -> Any:
        from eden.config import get_settings as _gs

        return getattr(_gs(), name)


# Module-level handle. Tests can patch this directly; production
# code reads through the proxy to get the live (possibly
# conftest-patched) settings instance.
settings = _SettingsProxy()

# The judge-score SELECT joins ``judge_scores`` to
# ``telemetry_events`` so we can attribute each score to an agent.
# The JOIN is left-side: judge rows without a matching
# telemetry event are dropped (their ``agent_id`` would be NULL).
_AGG_QUERY = """
    WITH joined AS (
        SELECT
            js.judge_name,
            js.score,
            js.rationale,
            js.trace_id,
            js.span_id,
            js.model,
            js.scored_at,
            te.attributes->>'agent_id' AS agent_id
        FROM judge_scores js
        LEFT JOIN telemetry_events te
          ON te.id::text = js.trace_id
        WHERE js.scored_at >= NOW() - INTERVAL '24 hours'
    )
    SELECT
        j.judge_name,
        j.score,
        j.rationale,
        j.trace_id,
        j.span_id,
        j.model,
        j.scored_at,
        j.agent_id,
        stats.dropped_null_agent_id
    FROM joined j
    CROSS JOIN (
        SELECT COUNT(*)::bigint AS dropped_null_agent_id
        FROM joined
        WHERE agent_id IS NULL
    ) stats
    WHERE j.agent_id IS NOT NULL
"""

_DROPPED_NULL_AGENT_ID = None


def _dropped_null_agent_id_counter() -> Any:
    """Lazy singleton — mirrors ``checkpoint_hook._Metrics`` pattern."""
    global _DROPPED_NULL_AGENT_ID
    if _DROPPED_NULL_AGENT_ID is None:
        from eden.observability.simple_metrics import Counter

        _DROPPED_NULL_AGENT_ID = Counter(
            "eden_evolution_dropped_null_agent_id_total",
            "Judge scores dropped from prompt-evolution scoring (missing agent_id)",
        )
    return _DROPPED_NULL_AGENT_ID


class EvolutionComponent:
    """Base class for evolution components.

    Holds the shared attributes the test suite wires up via
    ``__new__``: an LLM client, a ``last_run`` timestamp, and a
    ``prompt_versions`` client. Subclasses extend ``__init__`` to
    pull the real clients from the singletons.
    """

    llm: Any = None
    last_run: Any = None
    prompt_versions: Any = None

    def __init__(self, llm_client: Any = None) -> None:
        # NOTE: the unit tests build the evolver via ``__new__`` to
        # avoid the (defensive) ``get_postgres_client()`` call in
        # the original constructor — there was a pre-existing bug
        # in a sibling module where ``limit: int = 20`` shadowed
        # the built-in. We sidestep that path entirely.
        self.llm = llm_client
        self.last_run = None
        self.prompt_versions = None


class JudgeScorePromptEvolver(EvolutionComponent):
    """Read recent judge scores, generate prompt variants for degraded agents.

    Algorithm (per run):

    1. Pull the last 24h of ``judge_scores`` joined to
       ``telemetry_events`` for agent attribution.
    2. Group by ``(agent_id, judge_name)``. Compute the mean score
       and the sample count.
    3. Drop pairs with fewer than ``evolver_min_samples`` samples.
    4. Drop pairs whose mean score is at or above
       ``evolver_degradation_threshold`` (default 0.7).
    5. Sort the survivors by mean score ascending (most degraded
       first) and cap at ``evolver_max_variants_per_run``.
    6. For each survivor, fetch the agent's active prompt from
       ``prompt_versions``, ask the LLM for a revised prompt, and
       ``insert_version`` with ``active=False``,
       ``ab_test_active=True``, and the next ``ab_test_round``.

    The LLM call is best-effort: a missing/empty LLM response or a
    raised exception silently skips the agent. The evolver never
    raises to its caller.
    """

    def __init__(self, llm_client: Any = None) -> None:
        super().__init__(llm_client=llm_client)
        self.prompt_versions = None  # resolved lazily in run()

    async def _get_prompt_versions(self) -> Any:
        """Lazily resolve the prompt_versions client.

        The tests patch the source module's ``get_prompt_versions_client``
        symbol, so we re-read the attribute on every call.
        """

        return await _maybe_await(get_prompt_versions_client())

    async def _get_postgres(self) -> Any:
        """Lazily resolve the postgres client (with patch-friendly read)."""

        return await _maybe_await(get_postgres_client())

    async def _fetch_recent_judge_rows(self) -> list[dict[str, Any]]:
        """Pull the recent judge-score rows used by ``run``."""
        client = await self._get_postgres()
        rows = await client.fetch(_AGG_QUERY)
        rows_list = list(rows or [])
        dropped = 0
        if rows_list:
            dropped = int(rows_list[0].get("dropped_null_agent_id") or 0)
        if dropped > 0:
            logger.info(
                "evolution.dropped_null_agent_id: %d judge scores skipped "
                "(no agent_id attribution)",
                dropped,
            )
            with contextlib.suppress(Exception):  # metrics must never break scoring
                _dropped_null_agent_id_counter().inc(dropped)
        cleaned: list[dict[str, Any]] = []
        for row in rows_list:
            if isinstance(row, dict):
                cleaned.append(
                    {k: v for k, v in row.items() if k != "dropped_null_agent_id"}
                )
            else:
                cleaned.append(row)
        return cleaned

    def _aggregate_degraded(
        self, rows: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Group rows by (agent, judge), drop healthy / tiny groups,
        and return the most-degraded pairs first.
        """
        # ``settings`` is resolved through module-level
        # ``__getattr__`` so both ``patch("...components.settings")``
        # and the conftest's ``patch_settings`` fixture are honored.
        min_samples = settings.evolver_min_samples
        threshold = settings.evolver_degradation_threshold
        cap = settings.evolver_max_variants_per_run

        # Group scores per (agent, judge).
        groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for r in rows:
            agent = r.get("agent_id")
            judge = r.get("judge_name")
            if not agent or not judge:
                continue
            groups.setdefault((agent, judge), []).append(r)

        # Score each group; drop healthy / too-small.
        scored: list[dict[str, Any]] = []
        for (agent, judge), bucket in groups.items():
            if len(bucket) < min_samples:
                continue
            mean = sum(float(b.get("score") or 0.0) for b in bucket) / len(bucket)
            if mean >= threshold:
                continue
            scored.append(
                {
                    "agent": agent,
                    "judge_name": judge,
                    "mean_score": mean,
                    "sample_count": len(bucket),
                    "examples": bucket[:5],
                }
            )

        # Most-degraded (lowest mean) first; then cap.
        scored.sort(key=lambda d: d["mean_score"])
        return scored[:cap]

    async def _generate_variant(
        self, agent: str, judge: str, current_prompt: str, examples: list[dict]
    ) -> str:
        """Ask the LLM for a revised system prompt.

        The tests mock ``llm.call``; in production this returns the
        revised prompt text. Empty / None / raised → returns "" so
        the caller can skip the variant gracefully.
        """
        if not self.llm:
            return ""
        example_rationales = "\n".join(
            f"- {e.get('judge_name')}: {e.get('rationale')}" for e in examples
        )
        prompt = (
            f"You are improving the {agent} agent's system prompt.\n"
            f"The {judge} judge has been scoring it low.\n"
            f"Recent rationales:\n{example_rationales}\n\n"
            f"Current prompt:\n{current_prompt}\n\n"
            "Return only the improved system prompt, no commentary."
        )
        try:
            from eden.llm.internal_router import route_sync

            response = route_sync(
                "judge_prompt_evolver",
                prompt,
                slot="reasoning",
                max_tokens=800,
                llm_client=self.llm,
                output_type="text",
                requires_quality_check=False,
                description="Evolve agent system prompt from judge scores",
            )
            content = getattr(response, "content", response) or ""
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug(
                "JudgeScorePromptEvolver: LLM call failed for %s/%s: %s",
                agent,
                judge,
                exc,
            )
            return ""
        if not content or not str(content).strip():
            return ""
        return str(content).strip()

    async def run(self) -> dict[str, int]:
        """End-to-end evolution pass.

        Returns ``{"degradations_detected": int, "variants_generated": int}``.
        Never raises — DB errors return zero counts so the caller's
        flow is not broken.
        """
        try:
            rows = await self._fetch_recent_judge_rows()
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("JudgeScorePromptEvolver: DB fetch failed: %s", exc)
            self.last_run = "ran"
            return {"degradations_detected": 0, "variants_generated": 0}

        degraded = self._aggregate_degraded(rows)
        if not degraded:
            self.last_run = "ran"
            return {"degradations_detected": 0, "variants_generated": 0}

        try:
            pv = await self._get_prompt_versions()
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("JudgeScorePromptEvolver: prompt_versions failed: %s", exc)
            self.last_run = "ran"
            return {"degradations_detected": len(degraded), "variants_generated": 0}

        generated = 0
        for group in degraded:
            agent = group["agent"]
            try:
                active = await pv.get_active_prompt(agent)
            except Exception:  # pragma: no cover - defensive
                continue
            if not active:
                # No prompt to evolve — bootstrap case.
                continue

            current_prompt = active.get("system_prompt", "")
            current_version = int(active.get("version", 0))
            next_version = current_version + 1

            new_prompt = await self._generate_variant(
                agent=agent,
                judge=group["judge_name"],
                current_prompt=current_prompt,
                examples=group["examples"],
            )
            if not new_prompt:
                continue

            prior_round = int(
                (active.get("quality_metrics") or {}).get("ab_test_round", 0)
            )
            metrics = {
                "ab_test_active": True,
                "ab_test_round": prior_round + 1,
                "source_judges": [
                    {
                        "judge_name": group["judge_name"],
                        "mean_score": group["mean_score"],
                        "sample_count": group["sample_count"],
                    }
                ],
            }
            try:
                ok = await pv.insert_version(
                    agent=agent,
                    system_prompt=new_prompt,
                    version=next_version,
                    quality_metrics=metrics,
                    active=False,
                )
            except Exception:  # pragma: no cover - defensive
                continue
            if ok:
                generated += 1

        self.last_run = "ran"
        return {
            "degradations_detected": len(degraded),
            "variants_generated": generated,
        }


class PromptEvolvers(EvolutionComponent):
    """Canary-creation wrapper for judge-evolved prompt variants.

    When a new variant lands in ``prompt_versions`` (typically
    from :class:`JudgeScorePromptEvolver`), this component
    enrolls it in a canary at the configured traffic percentage:

    1. Read ``settings.evolver_auto_canary_pct``. If <= 0 (or
       not a parseable int), skip — variants stay inactive.
    2. Clamp the percentage to ``[0, 100]`` so a typo (e.g. 250)
       can't silently enroll the entire traffic in a canary.
    3. Resolve ``org_id`` from ``quality_metrics``; without it,
       fail closed (no fake canary success).
    4. INSERT ``prompt_canary_experiments`` +
       ``prompt_version_assignments`` (PromotionLoop + cockpit).
    5. Merge canary fields into ``quality_metrics`` (best-effort).
    6. Best-effort: write an ``evolver.auto_canary_created`` row
       to ``org_audit_log``. Audit failure does not block the
       canary (the experiment row stays enrolled).
    """

    def __init__(self, llm_client: Any = None) -> None:
        super().__init__(llm_client=llm_client)
        self.prompt_versions = None  # resolved lazily in _auto_create_canary

    async def _auto_create_canary(
        self,
        agent: str,
        version: int,
        round: int,
        *,
        org_id: str | None = None,
        control_version: int | None = None,
    ) -> bool:
        """Enroll the just-inserted variant in a canary.

        Returns ``True`` only if a ``prompt_canary_experiments`` row
        (and assignment) was written — the same table PromotionLoop
        and the improve cockpit read. Returns ``False`` when disabled,
        org_id cannot be resolved, or the experiment write fails.
        Audit-log failures are absorbed and do not flip success.
        """
        # Defensive: garbage config (e.g. "not-a-number") must not
        # silently enroll every variant. We treat any non-int as
        # "disabled" and skip.
        # ``settings`` is resolved through module-level
        # ``__getattr__`` so both ``patch("...components.settings")``
        # and the conftest's ``patch_settings`` fixture are honored.
        try:
            pct_raw = settings.evolver_auto_canary_pct
            pct = int(pct_raw)
        except (TypeError, ValueError):
            return False
        if pct <= 0:
            return False
        # Clamp to a sane range.
        pct = max(0, min(100, pct))

        if self.prompt_versions is None:
            # Lazy import so tests that build via __new__ can skip this.
            try:
                from eden.kb.prompt_versions.client import (
                    get_prompt_versions_client,
                )

                self.prompt_versions = await _maybe_await(
                    get_prompt_versions_client()
                )
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug(
                    "PromptEvolvers: prompt_versions client unavailable: %s",
                    exc,
                )
                self.prompt_versions = None

        from datetime import datetime
        from uuid import uuid4

        from eden.storage.postgres import get_postgres_client

        # Fail closed: cockpit + PromotionLoop read
        # ``prompt_canary_experiments``. Do not claim canary success
        # from quality_metrics alone (legacy ``prompt_canaries`` is
        # not written here).
        try:
            pg = await _maybe_await(get_postgres_client())
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug(
                "PromptEvolvers: postgres unavailable for canary %s v%s: %s",
                agent,
                version,
                exc,
            )
            return False

        resolved_org = org_id
        if not resolved_org:
            try:
                row = await pg.fetchrow(
                    "SELECT quality_metrics FROM prompt_versions "
                    "WHERE agent = $1 AND version = $2",
                    agent,
                    int(version),
                )
            except Exception:
                row = None
            if row:
                qm = row.get("quality_metrics")
                if isinstance(qm, dict):
                    resolved_org = qm.get("org_id")
                elif isinstance(qm, str):
                    try:
                        qm_parsed = json.loads(qm)
                        if isinstance(qm_parsed, dict):
                            resolved_org = qm_parsed.get("org_id")
                    except (TypeError, ValueError):
                        resolved_org = None
        if not resolved_org:
            logger.warning(
                "PromptEvolvers: cannot resolve org_id for %s v%s; "
                "auto-canary not enrolled (cockpit would not see it).",
                agent,
                version,
            )
            return False

        experiment_id = str(uuid4())
        ctrl = (
            int(control_version)
            if control_version is not None
            else max(0, int(version) - 1)
        )
        try:
            await pg.execute(
                "INSERT INTO prompt_canary_experiments ("
                "experiment_id, tenant_id, agent, control_version, "
                "candidate_version, traffic_pct, status, notes"
                ") VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)",
                experiment_id,
                resolved_org,
                agent,
                ctrl,
                int(version),
                pct,
                f"evolver auto-canary round={int(round)}",
            )
            await pg.execute(
                "INSERT INTO prompt_version_assignments ("
                "assignment_id, tenant_id, agent, version, traffic_pct, "
                "experiment_id, status"
                ") VALUES ($1, $2, $3, $4, $5, $6, 'active') "
                "ON CONFLICT (tenant_id, agent, version, experiment_id) "
                "DO UPDATE SET traffic_pct = $5",
                str(uuid4()),
                resolved_org,
                agent,
                int(version),
                pct,
                experiment_id,
            )
        except Exception as exc:
            logger.warning(
                "PromptEvolvers: prompt_canary_experiments INSERT "
                "failed for %s v%s: %s",
                agent,
                version,
                exc,
            )
            return False

        metrics = {
            "canary_status": "active",
            "canary_traffic_pct": pct,
            "ab_test_active": True,
            "ab_test_round": int(round),
            "canary_created_at": datetime.now(UTC).isoformat(),
            "experiment_id": experiment_id,
            "org_id": resolved_org,
        }
        if self.prompt_versions is not None:
            try:
                await self.prompt_versions.update_quality_metrics(
                    agent, version, metrics
                )
            except Exception as exc:  # pragma: no cover - defensive
                # Experiment row is the cockpit source of truth; metrics
                # are best-effort enrichment after a successful enroll.
                logger.debug(
                    "PromptEvolvers: update_quality_metrics failed for "
                    "%s v%s: %s",
                    agent,
                    version,
                    exc,
                )

        # Best-effort audit — never flips success after experiment write.
        try:
            user_id = await pg.fetchval(
                "SELECT id FROM users WHERE clerk_id = 'system' ORDER BY id LIMIT 1"
            )
            if not user_id:
                logger.debug(
                    "PromptEvolvers: no system user provisioned; "
                    "skipping org_audit_log INSERT for %s v%s.",
                    agent,
                    version,
                )
                return True
            metadata = {
                "agent": agent,
                "version": int(version),
                "traffic_pct": pct,
                "round": int(round),
                "experiment_id": experiment_id,
            }
            await pg.execute(
                "INSERT INTO org_audit_log ("
                "org_id, user_id, action, target_type, target_id, "
                "metadata, created_at"
                ") VALUES ($1, $2, $3, $4, $5, $6, NOW())",
                resolved_org,
                user_id,
                "evolver.auto_canary_created",
                "prompt_version",
                f"{agent}:{version}",
                json.dumps(metadata),
            )
        except Exception as exc:  # pragma: no cover - audit is best-effort
            logger.debug(
                "PromptEvolvers: org_audit_log INSERT failed for %s v%s: %s",
                agent,
                version,
                exc,
            )
        return True

    async def _generate_prompt_variants(
        self,
        agent: str,
        failure_jobs: list[dict[str, Any]],
        current_quality: dict[str, Any],
        previous_quality: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Generate candidate prompt variants for the degraded agent.

        The unit tests override this with ``patch.object`` — the
        production impl is a best-effort LLM call that returns an
        empty list on any failure (so the caller can degrade
        gracefully).
        """
        if not self.llm:
            return []
        try:
            response = self.llm.call(
                agent=agent,
                failure_jobs=failure_jobs,
                current_quality=current_quality,
                previous_quality=previous_quality,
            )
            if hasattr(response, "__await__"):
                response = await response
        except Exception:  # pragma: no cover - defensive
            return []
        # The LLM is expected to return a list of {"prompt": "..."}
        # dicts. Coerce dict-of-dict / string responses defensively.
        if isinstance(response, list):
            return [r for r in response if isinstance(r, dict) and r.get("prompt")]
        return []

    async def _handle_degradation(
        self,
        *,
        agent: str,
        current_version: int,
        failure_jobs: list[dict[str, Any]],
        current_quality: dict[str, Any],
        previous_quality: dict[str, Any],
        round: int = 1,
    ) -> int:
        """Insert generated variants and enroll each in a canary.

        Returns the number of variants successfully created. A
        failed insert skips the canary for that variant.
        """
        variants = await self._generate_prompt_variants(
            agent=agent,
            failure_jobs=failure_jobs,
            current_quality=current_quality,
            previous_quality=previous_quality,
        )
        if not variants:
            return 0

        if self.prompt_versions is None:
            from eden.kb.prompt_versions.client import get_prompt_versions_client

            self.prompt_versions = await _maybe_await(get_prompt_versions_client())

        created = 0
        for i, variant in enumerate(variants):
            new_version = current_version + 1 + i
            try:
                ok = await self.prompt_versions.insert_version(
                    agent=agent,
                    system_prompt=variant.get("prompt", ""),
                    version=new_version,
                    quality_metrics={"ab_test_active": True, "ab_test_round": round},
                    active=False,
                )
            except Exception:  # pragma: no cover - defensive
                continue
            if not ok:
                continue
            created += 1
            await self._auto_create_canary(agent, new_version, round)
        return created


class IssuePromptEvolver(EvolutionComponent):
    """Issue-driven prompt evolution (N18).

    When an issue is resolved with triage context, generate a prompt
    variant via prompts_v2 (:class:`~eden.services.prompt_versioning.PromptService`)
    and enroll it in a shadow canary via :class:`PromptEvolvers`.

    Migration 055 dropped the legacy ``prompt_versions`` schema that
    ``PromptVersionsClient`` targets — this evolver must not call
    those APIs or claim success when they no-op.
    """

    async def evolve_from_issue(
        self,
        org_id: str,
        issue_id: str,
        *,
        agent_id: str | None = None,
    ) -> dict[str, Any]:
        try:
            from eden.issues.repo import IssuesRepo

            issue = await IssuesRepo().get_issue(org_id, issue_id)
        except Exception as exc:
            logger.debug("IssuePromptEvolver load: %s", exc)
            return {
                "created": 0,
                "skipped": True,
                "reason": "load_failed",
                "error": str(exc),
            }
        if issue is None:
            return {"created": 0, "skipped": True, "reason": "not_found"}

        agent = agent_id or issue.agent_id
        if not agent:
            return {"created": 0, "skipped": True, "reason": "no_agent"}

        try:
            from eden.services.prompt_versioning import PromptService

            svc = PromptService()
        except Exception as exc:
            logger.warning(
                "IssuePromptEvolver: PromptService import failed: %s", exc
            )
            return {
                "created": 0,
                "skipped": True,
                "reason": "prompts_v2_unavailable",
                "error": (
                    "IssuePromptEvolver requires prompts_v2 PromptService; "
                    f"import failed: {exc}"
                ),
            }

        # Resolve the agent's actual registered prompt in prompts_v2.
        # BUG-8: there is no agent_id -> prompt_name mapping anywhere
        # in the codebase (the prompts_v2 ``prompts`` table has no
        # agent-linkage column — see
        # db_migrations/versions/055_prompt_versioning.py). We can
        # therefore only safely evolve agents whose id/slug is *also*
        # the exact prompts_v2 prompt name (the case where the
        # agent's real prompt was registered under that name). If no
        # prompt is registered under that name we fail loudly and
        # skip instead of silently minting a brand-new, unrelated
        # orphan prompt via ``create_version``'s implicit
        # ``create_prompt`` fallthrough.
        try:
            prompt_record = await svc.get_prompt(org_id, agent)
        except Exception as exc:
            logger.warning("IssuePromptEvolver get_prompt failed: %s", exc)
            return {
                "created": 0,
                "skipped": True,
                "reason": "prompts_v2_lookup_failed",
                "error": str(exc),
            }
        if prompt_record is None:
            logger.warning(
                "IssuePromptEvolver: no prompts_v2 prompt registered "
                "for agent=%s org_id=%s issue_id=%s; refusing to "
                "create an orphan prompt (BUG-8). Register a prompt "
                "named %r for this agent before it can be evolved "
                "via issue resolution.",
                agent,
                org_id,
                issue_id,
                agent,
            )
            return {
                "created": 0,
                "skipped": True,
                "reason": "no_prompt_mapping",
                "agent": agent,
                "error": (
                    f"No prompts_v2 prompt registered for agent "
                    f"{agent!r} in org {org_id!r}; refusing to mint "
                    "an orphan prompt"
                ),
            }

        try:
            versions = await svc.list_versions(org_id, agent, limit=1)
        except Exception as exc:
            logger.warning("IssuePromptEvolver list_versions failed: %s", exc)
            return {
                "created": 0,
                "skipped": True,
                "reason": "prompts_v2_list_failed",
                "error": str(exc),
            }

        latest = versions[0] if versions else None
        current_version = int((latest or {}).get("version") or 0)
        current_prompt = (
            (latest or {}).get("template")
            or f"Agent {agent} system prompt."
        )

        triage = issue.triage_result or {}
        summary = triage.get("summary") or triage.get("root_cause") or issue.title

        from eden.config import get_settings

        cfg = get_settings()
        revised = (
            f"{current_prompt}\n\n"
            f"# Resolved issue guardrail ({issue.fingerprint})\n"
            f"Avoid recurrence of: {summary}"
        )

        use_llm = False
        stumble_count = int(getattr(issue, "stumble_count", 0) or 0)
        if cfg.evolver_min_samples and stumble_count >= cfg.evolver_min_samples:
            use_llm = bool(triage.get("judge_regression"))

        if use_llm and self.llm is not None:
            try:
                resp = await self.llm.complete(
                    messages=[
                        {
                            "role": "user",
                            "content": (
                                "Append a minimal guardrail for: " + summary
                            ),
                        }
                    ]
                )
                extra = (resp.get("content") or "").strip()
                if extra:
                    revised = f"{current_prompt}\n\n{extra}"
            except Exception as exc:
                logger.debug("IssuePromptEvolver LLM path skipped: %s", exc)

        try:
            created = await svc.create_version(
                org_id,
                agent,
                template=revised,
                model="eden-evolver",
                params={
                    "source_issue_id": issue_id,
                    "evolver": "issue_prompt",
                    "ab_test_active": True,
                    "ab_test_round": 1,
                },
                change_note=f"issue_prompt_evolver:{issue_id}",
                created_by="issue_prompt_evolver",
                require_existing=True,
            )
        except Exception as exc:
            logger.warning("IssuePromptEvolver create_version failed: %s", exc)
            return {
                "created": 0,
                "skipped": True,
                "reason": "prompts_v2_create_failed",
                "error": str(exc),
            }

        if not created:
            return {
                "created": 0,
                "skipped": True,
                "reason": "prompts_v2_create_rejected",
                "error": (
                    "PromptService.create_version returned None — "
                    "prompts_v2 schema/DB unavailable (legacy "
                    "PromptVersionsClient is not used)"
                ),
            }

        new_version = int(created.get("version") or (current_version + 1))
        evolver = PromptEvolvers(llm_client=self.llm)
        canary_ok = await evolver._auto_create_canary(
            agent,
            new_version,
            round=1,
            org_id=org_id,
            control_version=current_version,
        )
        result: dict[str, Any] = {
            "created": 1,
            "agent": agent,
            "version": new_version,
            "issue_id": issue_id,
            "prompt_version_id": created.get("id"),
            "canary_enrolled": bool(canary_ok),
        }
        if not canary_ok:
            result["canary_error"] = (
                "auto_canary_not_enrolled — "
                "prompt_canary_experiments write failed or "
                "evolver_auto_canary_pct disabled"
            )

        # FEAT-92: attempt a draft GitHub fix PR (or stamp patch_blocked).
        try:
            from eden.agents.evolution.issue_fix_pr import attempt_issue_prompt_fix_pr

            fix_pr = await attempt_issue_prompt_fix_pr(
                org_id,
                issue_id,
                agent=agent,
                prompt_template=revised,
                issue_title=issue.title or "",
                fingerprint=issue.fingerprint or "",
            )
            result["fix_pr"] = fix_pr
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("IssuePromptEvolver fix_pr attempt failed: %s", exc)

        return result


async def _maybe_await(value: Any) -> Any:
    """Await ``value`` if it's awaitable, otherwise return as-is.

    Lets the singleton getters (which may be sync or async
    depending on test wiring) plug into a single call site.
    """
    if hasattr(value, "__await__"):
        return await value
    return value
