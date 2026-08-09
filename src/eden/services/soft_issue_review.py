"""Soft Autonomy Phase 7 — nightly soft-issue novelty review.

The detection stack is layered so cost stays flat while coverage
compounds:

* **L0/L1 (already live, ~$0)** — deterministic scanners + drift/stumble
  aggregates fire per trace. This job only *ranks* orgs/agents by those
  aggregates to decide where the expensive layer looks tonight.
* **L3 (this job)** — a single DeepSeek novelty-scout call per hot
  agent over a compact digest of ≤ ``soft_issue_review_traces_per_org``
  traces (default 50). The prompt includes the org's existing signal
  descriptions so the model is asked only for *novel* soft-failure
  shapes — things no current detector covers.
* **L4 (this job)** — each novel candidate is compiled via
  :func:`eden.services.cat2_intel.signals.compile_signal` and inserted
  into ``nl_signals`` as a **shadow detector** (``enabled=false``), so
  tomorrow's matches are free. Dedupe is content-addressed
  (``cluster_id = signal_signature(description)``) — re-running the
  night never creates duplicates.

Cost bound: ≤50 trace digests (~400 tok each) + ~1k output tokens per
agent, ≤3 hot agents per org → ≈ $0.01/org/night at DeepSeek flash
pricing, well under the $1/org/mo novelty budget. The org's
``daily_maintenance_budget_usd`` is checked before any LLM call and
spend is recorded via ``record_spend``.

Multi-pod safety: the cron tick claims the nightly window via Redis
SET NX; per-org work is additionally claimed so overlapping pods
skip orgs already in flight; DB dedupe by ``cluster_id`` is the final
backstop.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)

#: Hard caps regardless of config — the novelty budget contract.
_MAX_ORGS_PER_NIGHT = 20
_MAX_AGENTS_PER_ORG = 3
_MAX_TRACES_PER_ORG = 50
_MAX_NEW_DETECTORS_PER_ORG = 3
_MAX_DIGEST_CHARS = 600

#: Peak concurrent org reviews per nightly tick (OPT-24). Each org runs up
#: to ``_MAX_AGENTS_PER_ORG`` sequential LLM calls; keep well below the
#: Postgres pool size — mirrors ``_AUTO_CURATOR_CONCURRENCY`` in cron_tick.
_SOFT_ISSUE_REVIEW_CONCURRENCY = 8

#: Weekly shadow-promotion batch (OPT-26). Nightly creation is bounded by
#: ``_MAX_ORGS_PER_NIGHT × _MAX_NEW_DETECTORS_PER_ORG × 7 ≈ 420``/week;
#: evaluation must exceed that ceiling or the ``enabled=false`` backlog
#: grows without bound. Was 200 (verified backlog drift in pass-4).
_SHADOW_PROMOTE_BATCH_LIMIT = 500

#: Default age cap for shadow detectors that never reach ``min_firings`` (OPT-37).
_DEFAULT_SHADOW_HOLD_MAX_DAYS = 90


class SoftIssueReviewer:
    """Nightly L1 rank → L3 novelty scout → L4 shadow-detector learn."""

    async def run_once(self, *, dry_run: bool = False) -> dict[str, Any]:
        settings = get_settings()
        if not getattr(settings, "soft_issue_review_enabled", True):
            return {"skipped": True, "reason": "disabled"}

        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
        if pg is None:
            return {"skipped": True, "reason": "postgres_unavailable"}

        org_ids = await self._rank_hot_orgs(pg)
        out: dict[str, Any] = {
            "orgs_ranked": len(org_ids),
            "orgs_reviewed": 0,
            "detectors_created": 0,
            "spend_usd": 0.0,
            "orgs": [],
        }
        if dry_run:
            out["orgs"] = [{"org_id": oid, "dry_run": True} for oid in org_ids]
            return out

        from eden.async_tasks import bounded_gather

        async def _review_claimed_org(org_id: str) -> dict[str, Any] | None:
            claimed = await self._claim_org(org_id)
            if not claimed:
                return None
            try:
                return await self._review_org(pg, org_id)
            except Exception as exc:  # noqa: BLE001 — one org must not abort the night
                logger.exception("soft_issue_review: org=%s failed: %s", org_id, exc)
                return {"org_id": org_id, "errors": [str(exc)[:200]]}

        # Was a strictly sequential ``for`` over up to 20 orgs, each with up
        # to 3 LLM calls — wall clock was the *sum* of every org's latency.
        # ``_claim_org`` (Redis SET NX) keeps cross-pod work safe; bounded
        # overlap here only affects single-pod tick duration.
        settled = await bounded_gather(
            *(_review_claimed_org(org_id) for org_id in org_ids),
            limit=_SOFT_ISSUE_REVIEW_CONCURRENCY,
            return_exceptions=True,
        )
        for org_id, outcome in zip(org_ids, settled, strict=True):
            if isinstance(outcome, BaseException):
                logger.exception(
                    "soft_issue_review: org=%s failed: %s", org_id, outcome
                )
                out["orgs"].append(
                    {"org_id": org_id, "errors": [str(outcome)[:200]]}
                )
                continue
            if outcome is None:
                continue
            out["orgs"].append(outcome)
            if "errors" not in outcome:
                out["orgs_reviewed"] += 1
                out["detectors_created"] += int(
                    outcome.get("detectors_created", 0)
                )
                out["spend_usd"] += float(outcome.get("spend_usd", 0.0))
        out["spend_usd"] = round(float(out["spend_usd"]), 6)
        return out

    # ── L1: rank ────────────────────────────────────────────────────

    async def _rank_hot_orgs(self, pg: Any) -> list[str]:
        """Orgs with the most fresh soft-issue activity in the last 24h.

        Pure SQL aggregate — this IS the L1 layer's output consumed as
        a ranking signal. Orgs with zero recent issues cost nothing.
        """
        try:
            rows = await pg.fetch(
                """
                SELECT org_id, COUNT(*) AS n
                FROM agent_issues
                WHERE last_seen >= now() - interval '24 hours'
                GROUP BY org_id
                ORDER BY n DESC
                LIMIT $1
                """,
                _MAX_ORGS_PER_NIGHT,
            )
            return [str(r["org_id"]) for r in rows]
        except Exception as exc:
            logger.warning("soft_issue_review: rank failed: %s", exc)
            return []

    async def _hot_agents(self, pg: Any, org_id: str) -> list[str]:
        try:
            rows = await pg.fetch(
                """
                SELECT agent_id FROM agent_issues
                WHERE org_id = $1 AND agent_id IS NOT NULL
                  AND last_seen >= now() - interval '24 hours'
                GROUP BY agent_id
                ORDER BY COUNT(*) DESC
                LIMIT $2
                """,
                org_id,
                _MAX_AGENTS_PER_ORG,
            )
            return [str(r["agent_id"]) for r in rows]
        except Exception:
            return []

    # ── L3: novelty scout ───────────────────────────────────────────

    async def _review_org(self, pg: Any, org_id: str) -> dict[str, Any]:
        from eden.closed_loop.autonomy_policy import check_budget, record_spend

        ok, spent, limit = await check_budget(org_id)
        if not ok:
            return {
                "org_id": org_id,
                "skipped": True,
                "reason": "budget_exhausted",
                "spent_usd": spent,
                "limit_usd": limit,
            }

        agents = await self._hot_agents(pg, org_id)
        if not agents:
            return {"org_id": org_id, "skipped": True, "reason": "no_hot_agents"}

        existing = await self._existing_signal_descriptions(pg, org_id)
        per_org_trace_cap = min(
            int(getattr(get_settings(), "soft_issue_review_traces_per_org", 50) or 50),
            _MAX_TRACES_PER_ORG,
        )
        per_agent_cap = max(5, per_org_trace_cap // max(1, len(agents)))

        created = 0
        spend = 0.0
        for agent_id in agents:
            if created >= _MAX_NEW_DETECTORS_PER_ORG:
                break
            traces = await self._sample_traces(pg, org_id, agent_id, per_agent_cap)
            if len(traces) < 5:
                continue
            candidates, cost = await self._scout_novel_patterns(
                org_id, agent_id, traces, existing
            )
            spend += cost
            for description in candidates:
                if created >= _MAX_NEW_DETECTORS_PER_ORG:
                    break
                made = await self._create_shadow_detector(
                    pg, org_id, agent_id, description
                )
                if made:
                    created += 1
                    existing.append(description)

        if spend > 0:
            await record_spend(
                org_id,
                spend,
                feature="soft_issue_review",
                model="deepseek/deepseek-v4-flash-0731",
                metadata={"agents": len(agents), "detectors_created": created},
            )
        return {
            "org_id": org_id,
            "agents": len(agents),
            "detectors_created": created,
            "spend_usd": round(spend, 6),
        }

    async def _sample_traces(
        self, pg: Any, org_id: str, agent_id: str, limit: int
    ) -> list[dict[str, Any]]:
        """Compact digests of recent non-success / high-cost traces.

        Same telemetry shape the AutoCurator samples, but capped much
        lower — the scout needs a representative slice, not the full day.
        """
        try:
            rows = await pg.fetch(
                """
                SELECT trace_id::text AS trace_id,
                       span_name,
                       outcome,
                       COALESCE(attributes->>'stumble_kind', '') AS stumble_kind,
                       COALESCE(attributes->>'error', '') AS error,
                       COALESCE(attributes->>'cost_usd', '0') AS cost_usd
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND timestamp >= now() - interval '24 hours'
                  AND attributes->>'agent_id' = $2
                  AND (outcome IS DISTINCT FROM 'success'
                       OR COALESCE((NULLIF(attributes->>'cost_usd', ''))::float, 0) > 0.05)
                ORDER BY timestamp DESC
                LIMIT $3
                """,
                org_id,
                agent_id,
                limit,
            )
            return [dict(r) for r in rows]
        except Exception as exc:
            logger.debug("soft_issue_review: sample failed org=%s: %s", org_id, exc)
            return []

    async def _existing_signal_descriptions(
        self, pg: Any, org_id: str
    ) -> list[str]:
        try:
            rows = await pg.fetch(
                "SELECT description FROM nl_signals WHERE org_id = $1 "
                "ORDER BY created_at DESC LIMIT 100",
                org_id,
            )
            return [str(r["description"]) for r in rows]
        except Exception:
            return []

    async def _scout_novel_patterns(
        self,
        org_id: str,
        agent_id: str,
        traces: list[dict[str, Any]],
        existing: list[str],
    ) -> tuple[list[str], float]:
        """One DeepSeek call: which soft-failure shapes here are NOT
        covered by the existing detectors? Returns (descriptions, cost)."""
        from eden.llm.internal_router import route_async

        digest_lines = []
        for t in traces:
            line = (
                f"- {t.get('span_name') or 'span'} outcome={t.get('outcome') or '?'} "
                f"stumble={t.get('stumble_kind') or '-'} "
                f"err={(t.get('error') or '')[:120]}"
            )
            digest_lines.append(line[:_MAX_DIGEST_CHARS])
        digest = "\n".join(digest_lines)
        existing_block = "\n".join(f"- {d[:160]}" for d in existing[:50]) or "(none)"

        system = (
            "You are Eden's soft-failure novelty scout. You review a digest of "
            "an AI agent's recent failing/costly traces plus the org's existing "
            "detector descriptions. Identify ONLY genuinely novel, recurring "
            "soft-failure patterns NOT covered by the existing detectors. "
            "Each pattern must be a one-sentence plain-English detector "
            "description a rule compiler could match (e.g. 'agent repeatedly "
            "re-asks the user for information it already received'). "
            'Return JSON: {"patterns": [string, ...]} — at most 3, empty '
            "array when nothing is novel. No explanations."
        )
        prompt = (
            f"EXISTING DETECTORS:\n{existing_block}\n\n"
            f"TRACE DIGEST ({len(traces)} traces, agent {agent_id}):\n{digest}"
        )
        try:
            resp = await route_async(
                "soft_issue_review",
                prompt,
                slot="fast",
                system_prompt=system,
                description="nightly soft-issue novelty scout",
                output_type="json",
                expected_min_length=2,
                org_id=org_id,
                feature="soft_issue_review",
                max_tokens=600,
            )
        except Exception as exc:
            logger.debug("soft_issue_review: scout call failed org=%s: %s", org_id, exc)
            return [], 0.0

        cost = float(getattr(resp.usage, "cost", None) or 0.0)
        patterns = self._parse_patterns(resp.content)
        return patterns, cost

    @staticmethod
    def _parse_patterns(content: str | None) -> list[str]:
        """Extract the patterns array; tolerate prose-wrapped JSON."""
        try:
            payload = json.loads(content or "{}")
        except (TypeError, ValueError):
            m = re.search(r"\{.*\}", content or "", re.DOTALL)
            if not m:
                return []
            try:
                payload = json.loads(m.group(0))
            except (TypeError, ValueError):
                return []
        patterns = payload.get("patterns")
        if not isinstance(patterns, list):
            return []
        out: list[str] = []
        for p in patterns:
            if len(out) >= _MAX_NEW_DETECTORS_PER_ORG:
                break
            text = str(p).strip()
            if 20 <= len(text) <= 300:
                out.append(text)
        return out

    # ── L4: learn shadow detectors ──────────────────────────────────

    async def _create_shadow_detector(
        self, pg: Any, org_id: str, agent_id: str, description: str
    ) -> bool:
        """Compile + insert a disabled (shadow) nl_signal. Dedupe by
        content-addressed ``cluster_id`` — re-runs are idempotent."""
        from eden.services.cat2_intel.signals import compile_signal, signal_signature

        try:
            rule = compile_signal(description)
        except Exception as exc:
            logger.debug("soft_issue_review: compile failed: %s", exc)
            return False
        cluster_id = f"auto:{signal_signature(description)}"
        try:
            # Dedupe: same org + same content signature already exists.
            # Existence check — order irrelevant. lint:unordered-limit-ok
            dupe = await pg.fetchval(
                "SELECT 1 FROM nl_signals WHERE org_id = $1 AND cluster_id = $2 LIMIT 1"
                " -- lint:unordered-limit-ok",
                org_id,
                cluster_id,
            )
            if dupe:
                return False
            await pg.execute(
                """
                INSERT INTO nl_signals
                    (id, org_id, description, rule, enabled, created_by, cluster_id)
                VALUES ($1, $2, $3, $4::jsonb, FALSE, NULL, $5)
                """,
                str(uuid.uuid4()),
                org_id,
                f"[auto:{agent_id}] {description}",
                json.dumps(rule.to_dict()),
                cluster_id,
            )
            logger.info(
                "soft_issue_review: shadow detector created org=%s agent=%s: %s",
                org_id,
                agent_id,
                description[:120],
            )
            return True
        except Exception as exc:
            logger.debug("soft_issue_review: detector insert failed: %s", exc)
            return False

    # ── M13 (§6.5): weekly shadow promote / delete ──────────────────

    async def promote_shadow_detectors(
        self, *, dry_run: bool = False
    ) -> dict[str, Any]:
        """Weekly job: precision ≥ 0.8 over ≥ 20 firings → enable + Slack;
        precision < 0.3 → auto-delete. Uses operator confirm/dismiss
        counters in ``rule`` JSONB when present; else falls back to
        ``match_count`` as firings with precision=1.0 only when an
        explicit ``operator_confirms`` key exists (never auto-promote
        on match_count alone without labels).
        """
        settings = get_settings()
        min_firings = int(getattr(settings, "shadow_promote_min_firings", 20) or 20)
        promote_p = float(getattr(settings, "shadow_promote_precision", 0.8) or 0.8)
        delete_p = float(getattr(settings, "shadow_delete_precision", 0.3) or 0.3)
        hold_max_days = int(
            getattr(settings, "shadow_hold_max_days", _DEFAULT_SHADOW_HOLD_MAX_DAYS)
            or _DEFAULT_SHADOW_HOLD_MAX_DAYS
        )

        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
        if pg is None:
            return {"skipped": True, "reason": "postgres_unavailable"}

        try:
            rows = await pg.fetch(
                """
                SELECT id, org_id, description, rule, match_count, cluster_id,
                       created_at, updated_at
                FROM (
                    SELECT id, org_id, description, rule, match_count,
                           cluster_id, created_at, updated_at,
                           ROW_NUMBER() OVER (
                               PARTITION BY org_id ORDER BY created_at ASC
                           ) AS rn
                    FROM nl_signals
                    WHERE enabled = FALSE
                      AND cluster_id LIKE 'auto:%'
                ) ranked
                ORDER BY rn ASC, created_at ASC
                LIMIT $1
                """,
                _SHADOW_PROMOTE_BATCH_LIMIT,
            )
        except Exception as exc:
            logger.debug("promote_shadow_detectors: scan failed: %s", exc)
            return {"skipped": True, "reason": str(exc)[:200]}

        promoted = 0
        deleted = 0
        inspected = 0
        details: list[dict[str, Any]] = []
        for row in rows or []:
            r = dict(row)
            inspected += 1
            decision = evaluate_shadow_precision(
                r,
                min_firings=min_firings,
                promote_precision=promote_p,
                delete_precision=delete_p,
                hold_max_days=hold_max_days,
            )
            action = decision["action"]
            if action == "hold" or dry_run:
                details.append({**decision, "id": str(r["id"]), "dry_run": dry_run})
                continue
            sig_id = str(r["id"])
            org_id = str(r["org_id"])
            try:
                if action == "promote":
                    await pg.execute(
                        "UPDATE nl_signals SET enabled = TRUE WHERE id = $1 AND org_id = $2",
                        sig_id,
                        org_id,
                    )
                    promoted += 1
                    await _notify_shadow_promoted(
                        org_id,
                        signal_id=sig_id,
                        description=str(r.get("description") or "")[:200],
                        precision=decision["precision"],
                        firings=decision["firings"],
                    )
                elif action == "delete":
                    await pg.execute(
                        "DELETE FROM nl_signals WHERE id = $1 AND org_id = $2",
                        sig_id,
                        org_id,
                    )
                    deleted += 1
            except Exception as exc:
                logger.debug(
                    "promote_shadow_detectors: %s failed id=%s: %s",
                    action,
                    sig_id,
                    exc,
                )
                details.append(
                    {
                        **decision,
                        "id": sig_id,
                        "error": str(exc)[:160],
                    }
                )
                continue
            details.append({**decision, "id": sig_id})
        return {
            "inspected": inspected,
            "promoted": promoted,
            "deleted": deleted,
            "details": details,
        }

    # ── Multi-pod claims ────────────────────────────────────────────

    async def _claim_org(self, org_id: str) -> bool:
        """Redis SET NX per org per night — overlapping pods skip.

        The claim doubles as the once-per-night marker (never released):
        the nightly window claim in cron_tick is the scheduling gate;
        this key just prevents double-work if two pods win overlapping
        ticks. DB dedupe by cluster_id is the final backstop.
        """
        try:
            from datetime import UTC, datetime

            from eden.storage.redis import get_redis_client

            redis = await get_redis_client()
            if redis is None:
                return True
            day = datetime.now(UTC).date().isoformat()
            ok = await redis.set(
                f"eden:soft_issue_review:org:{day}:{org_id}",
                "1",
                nx=True,
                ex=20 * 3600,
            )
            return bool(ok)
        except Exception:  # noqa: BLE001 — fail open, DB dedupe is the backstop
            return True


def _parse_shadow_timestamp(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    except (TypeError, ValueError):
        return None


def _shadow_hold_age_days(row: dict[str, Any], *, now: datetime | None = None) -> float | None:
    ref = _parse_shadow_timestamp(row.get("updated_at")) or _parse_shadow_timestamp(
        row.get("created_at")
    )
    if ref is None:
        return None
    anchor = now or datetime.now(UTC)
    return (anchor - ref).total_seconds() / 86400.0


def evaluate_shadow_precision(
    row: dict[str, Any],
    *,
    min_firings: int = 20,
    promote_precision: float = 0.8,
    delete_precision: float = 0.3,
    hold_max_days: int | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Pure decision helper for §6.5 (testable without DB).

    Operator confirm/dismiss live in ``rule.operator_confirms`` /
    ``rule.operator_dismisses`` (or top-level keys). Firings prefer
    ``rule.firings`` then ``match_count``.
    """
    rule = row.get("rule") or {}
    if isinstance(rule, str):
        try:
            rule = json.loads(rule)
        except Exception:
            rule = {}
    confirms = int(
        rule.get("operator_confirms")
        or row.get("operator_confirms")
        or 0
    )
    dismisses = int(
        rule.get("operator_dismisses")
        or row.get("operator_dismisses")
        or 0
    )
    labeled = confirms + dismisses
    firings = int(
        rule.get("firings")
        or row.get("firings")
        or row.get("match_count")
        or 0
    )
    if labeled > 0:
        precision = confirms / labeled
        # Prefer labeled count as the sample size when present.
        sample = max(firings, labeled)
    else:
        # No operator labels — never auto-promote; may delete only if
        # match_count is huge and we have an explicit low-precision hint.
        precision = None
        sample = firings

    action = "hold"
    if sample >= min_firings and precision is not None:
        if precision >= promote_precision:
            action = "promote"
        elif precision < delete_precision:
            action = "delete"

    # OPT-37: stale shadow detectors that never reach min_firings expire.
    hold_age_days: float | None = None
    if action == "hold" and hold_max_days is not None and sample < min_firings:
        hold_age_days = _shadow_hold_age_days(row, now=now)
        if hold_age_days is not None and hold_age_days >= float(hold_max_days):
            action = "delete"

    return {
        "action": action,
        "precision": precision,
        "firings": sample,
        "confirms": confirms,
        "dismisses": dismisses,
        "hold_age_days": hold_age_days,
    }


async def record_shadow_feedback(
    org_id: str,
    signal_id: str,
    *,
    confirm: bool | None = None,
    dismiss: bool | None = None,
) -> bool:
    """M13 (§6.5): bump operator confirm/dismiss on a shadow detector.

    P0-C (FEAT-29): dismiss is made *consequential immediately* — after
    bumping the counter we re-evaluate the same promote/delete thresholds
    the weekly ``promote_shadow_detectors`` sweep uses (§6.5) and, if the
    detector now crosses the delete threshold, remove it inline instead of
    waiting for the next weekly run to notice. The weekly sweep is kept as
    a safety net (e.g. for signals whose counters moved via other paths).
    """
    if confirm is None and dismiss is None:
        return False
    try:
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
        if pg is None:
            return False
        bump_c = 1 if confirm else 0
        bump_d = 1 if dismiss else 0
        row = await pg.fetchrow(
            """
            UPDATE nl_signals SET
                rule = jsonb_set(
                    jsonb_set(
                        COALESCE(rule, '{}'::jsonb),
                        '{operator_confirms}',
                        to_jsonb(
                            COALESCE((rule->>'operator_confirms')::int, 0) + $3
                        ),
                        true
                    ),
                    '{operator_dismisses}',
                    to_jsonb(
                        COALESCE((rule->>'operator_dismisses')::int, 0) + $4
                    ),
                    true
                ),
                updated_at = NOW()
            WHERE id = $1 AND org_id = $2
            RETURNING id, org_id, description, rule, match_count, cluster_id,
                      enabled
            """,
            signal_id,
            org_id,
            bump_c,
            bump_d,
        )
        if dismiss and row is not None:
            await _maybe_auto_disable_on_dismiss(pg, dict(row))
        return True
    except Exception as exc:
        logger.debug("record_shadow_feedback failed: %s", exc)
        return False


async def _maybe_auto_disable_on_dismiss(pg: Any, row: dict[str, Any]) -> None:
    """Inline counterpart to the weekly ``promote_shadow_detectors`` delete
    path: reuse the exact same thresholds (min firings / delete precision)
    so a shadow detector doesn't have to survive up to a week of noisy
    dismissals before it's taken down.
    """
    try:
        # Only ever-shadow (never-promoted) auto-created detectors are
        # eligible — matches the weekly sweep's own scan filter
        # (`enabled = FALSE AND cluster_id LIKE 'auto:%'`).
        cluster_id = row.get("cluster_id") or ""
        if row.get("enabled") or not str(cluster_id).startswith("auto:"):
            return
        settings = get_settings()
        min_firings = int(
            getattr(settings, "shadow_promote_min_firings", 20) or 20
        )
        promote_p = float(
            getattr(settings, "shadow_promote_precision", 0.8) or 0.8
        )
        delete_p = float(
            getattr(settings, "shadow_delete_precision", 0.3) or 0.3
        )
        hold_max_days = int(
            getattr(settings, "shadow_hold_max_days", _DEFAULT_SHADOW_HOLD_MAX_DAYS)
            or _DEFAULT_SHADOW_HOLD_MAX_DAYS
        )
        decision = evaluate_shadow_precision(
            row,
            min_firings=min_firings,
            promote_precision=promote_p,
            delete_precision=delete_p,
            hold_max_days=hold_max_days,
        )
        if decision["action"] != "delete":
            return
        sig_id = str(row["id"])
        org_id = str(row["org_id"])
        await pg.execute(
            "DELETE FROM nl_signals WHERE id = $1 AND org_id = $2",
            sig_id,
            org_id,
        )
        logger.info(
            "shadow detector auto-disabled on dismiss id=%s org=%s "
            "precision=%.2f firings=%s",
            sig_id,
            org_id,
            decision["precision"] or 0.0,
            decision["firings"],
        )
    except Exception as exc:
        logger.debug("_maybe_auto_disable_on_dismiss failed: %s", exc)


async def _notify_shadow_promoted(
    org_id: str,
    *,
    signal_id: str,
    description: str,
    precision: float | None,
    firings: int,
) -> None:
    try:
        from eden.services import slack_notify

        prec = f"{precision:.2f}" if precision is not None else "?"
        # Reuse needs_approval plumbing with a synthetic plan id so Slack
        # still resolves channel + dedupe without a new public helper.
        await slack_notify.notify_needs_approval(
            org_id,
            plan_id=f"shadow-{signal_id}",
            title=f"Shadow detector promoted ({prec}, n={firings}): {description[:120]}",
            kind="prompt_update",  # Fix-now lane so Slack fires
            queue="fix_now",
        )
    except Exception as exc:
        logger.debug("shadow promote slack failed: %s", exc)


__all__ = [
    "SoftIssueReviewer",
    "evaluate_shadow_precision",
    "record_shadow_feedback",
]
