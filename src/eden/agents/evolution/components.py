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
  inserted, it enrolls the variant in a canary at
  ``settings.evolver_auto_canary_pct`` traffic, updates the
  variant's ``quality_metrics`` JSONB with the canary metadata,
  and writes an ``evolver.auto_canary_created`` audit entry.

The two are deliberately decoupled so the canary stage can be
gated / opted-out via config (``evolver_auto_canary_pct=0``)
without touching the trigger.
"""

from __future__ import annotations

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
      AND te.attributes->>'agent_id' IS NOT NULL
"""


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
        return list(rows or [])

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
            response = self.llm.call(prompt)
            if hasattr(response, "__await__"):
                response = await response
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
    3. Call ``prompt_versions.update_quality_metrics`` with
       ``canary_status='active'``, ``canary_traffic_pct``,
       ``ab_test_active=True``, ``ab_test_round=round``, and a
       ``canary_created_at`` ISO timestamp.
    4. Best-effort: write an ``evolver.auto_canary_created`` row
       to ``org_audit_log``. Audit failure does not block the
       canary (the variant stays enrolled).
    """

    def __init__(self, llm_client: Any = None) -> None:
        super().__init__(llm_client=llm_client)
        self.prompt_versions = None  # resolved lazily in _auto_create_canary

    async def _auto_create_canary(
        self,
        agent: str,
        version: int,
        round: int,
    ) -> bool:
        """Enroll the just-inserted variant in a canary.

        Returns ``True`` if the canary was created, ``False`` if it
        was skipped (disabled, bad config, or variant update
        failed). Audit-log failures are absorbed — they never
        flip the return value to ``False``.
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
            from eden.kb.prompt_versions.client import get_prompt_versions_client

            self.prompt_versions = await _maybe_await(get_prompt_versions_client())

        from datetime import datetime

        metrics = {
            "canary_status": "active",
            "canary_traffic_pct": pct,
            "ab_test_active": True,
            "ab_test_round": int(round),
            "canary_created_at": datetime.now(UTC).isoformat(),
        }
        try:
            updated = await self.prompt_versions.update_quality_metrics(
                agent, version, metrics
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug(
                "PromptEvolvers: update_quality_metrics failed for %s v%s: %s",
                agent,
                version,
                exc,
            )
            return False
        if not updated:
            return False

        # Best-effort audit log. The ``prompt_versions`` table is
        # keyed by ``(agent, version)`` only — there is no
        # ``org_id`` column, so we cannot recover the owning tenant
        # from the schema. Audit 2026-07-07 — pre-fix the code did
        # ``SELECT id FROM organizations LIMIT 1`` /
        # ``SELECT id FROM users LIMIT 1``, which attributes every
        # canary-creation event to whatever org/user happened to be
        # at the top of the table. For a multi-tenant system that
        # is a tenant-isolation bug in the audit log (Org A's
        # evolver claim to have created a canary for Org B's agent
        # because both queries return the top-of-table row). The
        # safest fix is to skip the audit insert when we cannot
        # resolve the correct ``org_id`` — the canary is still
        # created, and operators see a clear log line instead of
        # a misleading audit row. Future work: add an ``org_id``
        # column to ``prompt_versions`` so this audit insert can be
        # tenant-correct.
        try:
            from eden.storage.postgres import get_postgres_client

            pg = await _maybe_await(get_postgres_client())
            org_id: str | None = None
            # The ``prompt_versions`` table does not carry an
            # ``org_id``; check whether the row's quality_metrics
            # JSONB carries one (set by the canary-creating path).
            # If not, we cannot reliably attribute the audit row.
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
                    org_id = qm.get("org_id")
                elif isinstance(qm, str):
                    try:
                        qm_parsed = json.loads(qm)
                        if isinstance(qm_parsed, dict):
                            org_id = qm_parsed.get("org_id")
                    except (TypeError, ValueError):
                        org_id = None
            if not org_id:
                logger.debug(
                    "PromptEvolvers: cannot resolve org_id for %s v%s; "
                    "skipping org_audit_log INSERT to avoid "
                    "cross-tenant attribution.",
                    agent,
                    version,
                )
                return True
            # No user context here (the evolver runs as a system
            # worker, not as an authenticated user). Look up the
            # "system" placeholder user; if it has not been
            # provisioned yet, skip the audit rather than blame an
            # arbitrary user. The audit table requires user_id NOT
            # NULL per migration 008.
            user_id = await pg.fetchval(
                "SELECT id FROM users WHERE clerk_id = 'system' LIMIT 1"
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
            }
            await pg.execute(
                "INSERT INTO org_audit_log ("
                "org_id, user_id, action, target_type, target_id, metadata, created_at"
                ") VALUES ($1, $2, $3, $4, $5, $6, NOW())",
                org_id,
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


async def _maybe_await(value: Any) -> Any:
    """Await ``value`` if it's awaitable, otherwise return as-is.

    Lets the singleton getters (which may be sync or async
    depending on test wiring) plug into a single call site.
    """
    if hasattr(value, "__await__"):
        return await value
    return value
