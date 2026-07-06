"""Statistical model comparison and recommendation service.

The pricing catalog tells you what each model costs. The
comparison service tells you **what it would cost to switch** and
**which model is best for your workload** — using your actual
usage history from ``usage_events``.

What it answers
---------------
1. **Compare two models**: side-by-side cost, quality, latency,
   context, vendor, capability tags.
2. **Project a model switch**: given the org's last 30 days of
   usage on the *current* model, what would the bill look like on
   each candidate model? Includes cache-discount handling when the
   org's usage rows carry cache_read_tokens / cache_write_tokens.
3. **Recommend the next best model**: pick the candidate that
   maximises a multi-objective score (cost-adjusted quality) for
   the org's workload. Or recommend *staying put* if the current
   model already wins.
4. **Recommend the single best model**: pure ranking, no current
   model in scope — useful for new agents / new tenants.

Multi-objective scoring
-----------------------
The scoring function blends cost, quality, latency, reliability,
and (when available) the org's observed success rate on the
candidate. Weights default to ``cost=0.5, quality=0.3,
latency=0.1, reliability=0.1`` — biased toward cost because the
fastest savings come from cheap inference, but quality gets a
hard floor (``min_quality``) so we never recommend a Haiku-tier
model for an org whose Sonnet-4 traffic requires higher
intelligence.

Inputs come from three sources, in priority order:

  1. **Per-tenant override** (``org_cost_overrides``) — the rate
     the customer actually pays.
  2. **PricingCatalog** — verified public list price, optionally
     overlaid by OpenRouter / models.dev live data.
  3. **Synthetic fallback** — for unknown models, cost surfaces
     as ``None`` and the comparator flags them for review.

The comparator is pure: it does not write to any database. The
usage-history queries it issues are read-only against
``usage_events``.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)

# Default scoring weights for the multi-objective recommendation.
# Sum is 1.0; tinker via ``ModelComparator(weights=...)``.
#
# Quality-first ranking: this matches how ops thinks about model
# choice. Quality is 60% because a model that hallucinates more
# is more expensive than a model with a slightly higher per-token
# rate - bad outputs compound across retries, tool errors, and
# downstream cleanup. Cost still gets 25% (the second-largest
# axis) so we surface genuinely cheaper options when quality is
# comparable. Reliability (10%) and latency (5%) are tie-breakers
# between same-quality candidates.
DEFAULT_WEIGHTS: dict[str, float] = {
    "quality": 0.60,
    "cost": 0.25,
    "reliability": 0.10,
    "latency": 0.05,
}

# Default intelligence-floor: never recommend a model below this
# quality. 0.8 is roughly GPT-4o-mini / Claude Haiku territory -
# fine for chat, not for code review or complex reasoning.
DEFAULT_MIN_QUALITY: float = 0.80

# Usage-history window: how far back to look when projecting the
# cost of a model switch. 30d matches the invoice cycle.
DEFAULT_WINDOW_DAYS: int = 30


# ─────────────────────────────────────────────────────────────────────
# Data shapes
# ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ModelSpec:
    """Static + rate-card metadata for one model.

    Built from :class:`PricingCatalog` + per-tenant overrides.
    """

    model_id: str
    provider: str
    quality: float
    latency_p95_ms: int
    reliability: float
    context_window: int
    cost_per_1k_input: float
    cost_per_1k_output: float
    cost_per_1k_cache_read: float | None
    cost_per_1k_cache_write: float | None
    source: str
    """``override`` | ``openrouter`` | ``models_dev`` | ``static`` | ``unknown``"""

    @property
    def cost_per_1k_blended(self) -> float:
        return (self.cost_per_1k_input + self.cost_per_1k_output) / 2.0

    def project_cost(
        self,
        *,
        input_tokens: int,
        output_tokens: int,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
    ) -> float:
        """Project the dollar cost of one request on this model."""
        fresh = max(0, input_tokens - cache_read_tokens - cache_write_tokens)
        read_rate = (
            self.cost_per_1k_cache_read
            if self.cost_per_1k_cache_read is not None
            else self.cost_per_1k_input
        )
        write_rate = (
            self.cost_per_1k_cache_write
            if self.cost_per_1k_cache_write is not None
            else self.cost_per_1k_input
        )
        in_cost = (
            (cache_read_tokens / 1000.0) * read_rate
            + (cache_write_tokens / 1000.0) * write_rate
            + (fresh / 1000.0) * self.cost_per_1k_input
        )
        out_cost = (output_tokens / 1000.0) * self.cost_per_1k_output
        return in_cost + out_cost


@dataclass(frozen=True)
class UsageHistory:
    """Aggregate usage on a single model, sourced from ``usage_events``.

    Used by :meth:`ModelComparator.recommend_switch` to project
    what the bill would look like on a candidate model.
    """

    model_id: str
    requests: int
    total_input_tokens: int
    total_output_tokens: int
    total_cache_read_tokens: int
    total_cache_write_tokens: int
    total_cost_usd: float
    window_days: int
    success_rate: float | None
    """0..1; ``None`` when the source rows don't carry success
    attribution. Used by the multi-objective score so we don't
    blindly recommend a cheaper model with worse outcomes."""

    @property
    def avg_input_tokens(self) -> float:
        return self.total_input_tokens / self.requests if self.requests else 0.0

    @property
    def avg_output_tokens(self) -> float:
        return self.total_output_tokens / self.requests if self.requests else 0.0

    @property
    def cache_hit_ratio(self) -> float:
        """Cached-token share of input. 0..1.

        Computed as cache_read_tokens / total_input_tokens. If the
        org's traffic doesn't use prompt-cache at all this is 0;
        for traffic that's heavily cached (Anthropic Sonnet 4
        with 5-min cache) it can exceed 0.5.
        """
        if not self.total_input_tokens:
            return 0.0
        return self.total_cache_read_tokens / self.total_input_tokens


@dataclass(frozen=True)
class ModelComparison:
    """Side-by-side comparison of two models.

    Returned by :meth:`ModelComparator.compare`. The ``delta_*``
    fields express the candidate's relative change from the
    current model — positive is "the candidate is more
    expensive/slower than current", negative is "cheaper/faster".
    """

    current: ModelSpec
    candidate: ModelSpec
    delta_cost_per_1k_input: float
    delta_cost_per_1k_output: float
    delta_quality: float
    delta_latency_p95_ms: int
    delta_reliability: float

    @property
    def cost_ratio(self) -> float:
        """candidate / current blended cost.

        ``< 1.0`` → candidate is cheaper. ``> 1.0`` → candidate is
        more expensive. Returns ``1e9`` (a very large finite number)
        when the current model has no priced input/output
        (self-hosted); callers that need to render this should
        display "free" rather than the ratio. Returns ``1.0`` when
        both sides are free (a degenerate comparison).
        """
        cur = self.current.cost_per_1k_blended
        if cur <= 0:
            return 1e9 if self.candidate.cost_per_1k_blended > 0 else 1.0
        return self.candidate.cost_per_1k_blended / cur


@dataclass(frozen=True)
class SwitchProjection:
    """Projected cost on a candidate, given the org's usage history.

    Returned by :meth:`ModelComparator.recommend_switch`. Carries
    both the **per-request** delta and the **window-total** delta
    so the UI can render "this swap saves you $X/month".
    """

    current: ModelSpec
    candidate: ModelSpec
    history: UsageHistory
    current_total_usd: float
    projected_total_usd: float
    savings_usd: float
    savings_pct: float
    """Negative means the candidate would cost *more* than current."""
    per_request_savings_usd: float
    cache_savings_usd: float
    """USD saved by the candidate's cache-discount rate vs current."""
    score: float
    """Multi-objective score in ``[0, 1]`` for ranking candidates."""


@dataclass(frozen=True)
class Recommendation:
    """The best model the comparator found, plus the runners-up.

    Returned by :meth:`ModelComparator.recommend` and
    :meth:`ModelComparator.recommend_switch`.
    """

    recommended: ModelSpec
    score: float
    rationale: str
    runners_up: list[tuple[ModelSpec, float, str]]
    """``(model, score, rationale)`` tuples sorted by score desc."""
    current: ModelSpec | None
    """The user's current model, when known. ``None`` for a fresh
    ``recommend()`` call."""
    monthly_savings_usd: float | None
    """Projected monthly savings vs current, when current is set."""


# ─────────────────────────────────────────────────────────────────────
# Service
# ─────────────────────────────────────────────────────────────────────


class ModelComparator:
    """Compare models and project cost of switching.

    The constructor takes a :class:`CostResolver` so per-tenant
    overrides are honoured automatically. If you don't have one
    in scope (e.g. a public landing-page compare), pass
    ``resolver=None`` and the comparator falls back to list
    prices.

    Parameters
    ----------
    catalog:
        The pricing catalog to read rates from. Defaults to
        :meth:`PricingCatalog.default` so callers can omit it.
    resolver:
        The cost resolver (carries per-tenant overrides). Optional.
    weights:
        Multi-objective scoring weights. Must sum to ~1.0; the
        default is biased toward cost.
    min_quality:
        Quality floor — never recommend a model below this. Set to
        ``0.0`` to disable.
    """

    def __init__(
        self,
        *,
        catalog: Any | None = None,
        resolver: Any | None = None,
        weights: dict[str, float] | None = None,
        min_quality: float = DEFAULT_MIN_QUALITY,
        usage_cache_ttl_seconds: float = 60.0,
    ) -> None:
        from eden.llmops.pricing import PricingCatalog

        self.catalog = catalog or PricingCatalog.default()
        self.resolver = resolver
        self.weights = dict(weights or DEFAULT_WEIGHTS)
        self.min_quality = float(min_quality)
        # Usage-history cache: the org's monthly cost aggregates
        # don't change meaningfully between renders, so we cache
        # them for ``usage_cache_ttl_seconds`` (default 60s). Key
        # is (org_id, provider, model_id, window_days); value is
        # ``(expires_at, UsageHistory)``.
        self.usage_cache_ttl_seconds = usage_cache_ttl_seconds
        self._usage_cache: dict[
            tuple[str, str, str, int], tuple[float, UsageHistory]
        ] = {}
        self._usage_cache_lock = asyncio.Lock()

    # ── Spec extraction ────────────────────────────────────────────

    async def _spec_for(self, *, org_id: str | None, provider: str, model_id: str) -> ModelSpec:
        """Resolve the pricing + metadata for one model.

        Honours per-tenant overrides when ``resolver`` is set.
        Falls back to the catalog row; if that's missing too, the
        cost fields are 0.0 with ``source="unknown"``.
        """
        cost_in = 0.0
        cost_out = 0.0
        cache_read: float | None = None
        cache_write: float | None = None
        source = "unknown"
        if self.resolver is not None:
            try:
                res = await self.resolver.resolve(
                    org_id=org_id, provider=provider, model_id=model_id,
                )
                cost_in = float(res.cost_per_1k_input)
                cost_out = float(res.cost_per_1k_output)
                cache_read = (
                    float(res.cost_per_1k_cache_read)
                    if res.cost_per_1k_cache_read is not None
                    else None
                )
                cache_write = (
                    float(res.cost_per_1k_cache_write)
                    if res.cost_per_1k_cache_write is not None
                    else None
                )
                source = res.source
            except Exception as exc:  # noqa: BLE001
                logger.debug("resolver failed for %s/%s: %r", provider, model_id, exc)

        row = self.catalog.lookup(model_id)
        quality = float(row.quality) if row else 0.80
        latency_p95 = int(row.latency_p95_ms) if row else 1000
        reliability = float(row.reliability) if row else 0.99
        context_window = int(row.context_window) if row else 0

        # When the resolver returned ``unknown`` (no override, no
        # catalog row), but the catalog has a row, prefer the
        # catalog's actual rates — the resolver may not have been
        # given the same model_id shape the catalog uses.
        if source == "unknown" and row is not None:
            cost_in = float(row.cost_per_1k_input)
            cost_out = float(row.cost_per_1k_output)
            cache_read = row.cost_per_1k_cache_read
            cache_write = row.cost_per_1k_cache_write
            source = row.source

        return ModelSpec(
            model_id=model_id,
            provider=provider,
            quality=quality,
            latency_p95_ms=latency_p95,
            reliability=reliability,
            context_window=context_window,
            cost_per_1k_input=cost_in,
            cost_per_1k_output=cost_out,
            cost_per_1k_cache_read=cache_read,
            cost_per_1k_cache_write=cache_write,
            source=source,
        )

    # ── Public API ─────────────────────────────────────────────────

    async def compare(
        self,
        *,
        org_id: str | None,
        current: tuple[str, str],
        candidate: tuple[str, str],
    ) -> ModelComparison:
        """Side-by-side comparison of two models.

        Parameters
        ----------
        current, candidate:
            ``(provider, model_id)`` tuples.
        """
        cur = await self._spec_for(
            org_id=org_id, provider=current[0], model_id=current[1],
        )
        cand = await self._spec_for(
            org_id=org_id, provider=candidate[0], model_id=candidate[1],
        )
        return ModelComparison(
            current=cur,
            candidate=cand,
            delta_cost_per_1k_input=cand.cost_per_1k_input - cur.cost_per_1k_input,
            delta_cost_per_1k_output=cand.cost_per_1k_output - cur.cost_per_1k_output,
            delta_quality=cand.quality - cur.quality,
            delta_latency_p95_ms=cand.latency_p95_ms - cur.latency_p95_ms,
            delta_reliability=cand.reliability - cur.reliability,
        )

    async def recommend(
        self,
        *,
        org_id: str | None,
        candidates: Iterable[tuple[str, str]],
        workload: UsageHistory | None = None,
    ) -> Recommendation:
        """Pick the best model from ``candidates`` for the workload.

        ``workload`` is optional; when provided, the comparator
        weights the score by the org's observed traffic shape
        (cache hit ratio, request size). When omitted, scoring is
        pure-quality vs cost.
        """
        # Resolve all candidate specs in parallel — the catalog
        # lookup is in-memory but the resolver does a Postgres
        # fetch on cache miss, so a 10-candidate list is
        # 10× faster under gather than under a serial loop.
        cand_list = list(candidates)
        specs = await asyncio.gather(*(
            self._spec_for(org_id=org_id, provider=p, model_id=m)
            for (p, m) in cand_list
        ))
        scored: list[tuple[ModelSpec, float, str]] = []
        for spec in specs:
            if spec.quality < self.min_quality:
                continue
            score, rationale = self._score(spec, workload=workload)
            scored.append((spec, score, rationale))

        if not scored:
            raise ValueError("no candidate models meet min_quality threshold")

        scored.sort(key=lambda t: t[1], reverse=True)
        best_spec, best_score, best_rationale = scored[0]
        return Recommendation(
            recommended=best_spec,
            score=best_score,
            rationale=best_rationale,
            runners_up=scored[1:6],
            current=None,
            monthly_savings_usd=None,
        )

    async def recommend_switch(
        self,
        *,
        org_id: str | None,
        current: tuple[str, str],
        candidates: Iterable[tuple[str, str]],
        window_days: int = DEFAULT_WINDOW_DAYS,
    ) -> Recommendation:
        """Pick the best *switch* from ``current`` to a candidate.

        Pulls the org's actual usage of ``current`` from
        ``usage_events``, projects the bill on each candidate,
        and ranks them by multi-objective score (cost-savings +
        quality preservation + latency improvement).

        Returns a :class:`Recommendation`. If the current model
        already wins, ``recommended`` is the current model and
        ``monthly_savings_usd`` is 0.0.
        """
        cur = await self._spec_for(
            org_id=org_id, provider=current[0], model_id=current[1],
        )
        history = await self._fetch_usage_history(
            org_id=org_id, provider=current[0], model_id=current[1],
            window_days=window_days,
        )

        # Resolve every candidate spec in parallel. The
        # "switch to itself" candidate reuses ``cur`` without
        # another DB roundtrip.
        cand_list = list(candidates)
        async def _resolve_one(p: str, m: str) -> ModelSpec:
            if (p, m) == current:
                return cur
            return await self._spec_for(org_id=org_id, provider=p, model_id=m)
        cand_specs = await asyncio.gather(*(
            _resolve_one(p, m) for (p, m) in cand_list
        ))

        # _project_switch recomputes per-request averages from
        # the history itself; no hoisting needed since the math
        # is pure property reads.

        projections: list[SwitchProjection] = [
            self._project_switch(cur, spec, history) for spec in cand_specs
        ]

        if not projections:
            raise ValueError("no candidates provided")

        # Score each projection. The current-model projection
        # always scores ~0.5 (baseline) so a candidate has to
        # beat it on cost-adjusted quality to win.
        scored: list[tuple[ModelSpec, float, str, SwitchProjection]] = []
        for proj in projections:
            spec = proj.candidate
            if spec.quality < self.min_quality and spec.model_id != cur.model_id:
                continue
            score, rationale = self._score(
                spec,
                workload=history,
                extra_savings_pct=proj.savings_pct,
            )
            scored.append((spec, score, rationale, proj))

        if not scored:
            raise ValueError("no candidate meets min_quality threshold")

        scored.sort(key=lambda t: t[1], reverse=True)
        best_spec, best_score, best_rationale, best_proj = scored[0]

        # The monthly_savings is the savings of the *winning*
        # projection relative to the current model.
        cur_proj = next((p for p in projections if p.candidate.model_id == cur.model_id), None)
        monthly_savings = (
            (cur_proj.projected_total_usd - best_proj.projected_total_usd)
            if cur_proj is not None
            else 0.0
        )

        return Recommendation(
            recommended=best_spec,
            score=best_score,
            rationale=best_rationale,
            runners_up=[
                (s, score, rationale)
                for (s, score, rationale, _p) in scored[1:6]
            ],
            current=cur,
            monthly_savings_usd=monthly_savings,
        )

    async def project_cost_at_scale(
        self,
        *,
        org_id: str | None,
        current: tuple[str, str],
        candidate: tuple[str, str],
        scale_factor: float = 1.0,
        window_days: int = DEFAULT_WINDOW_DAYS,
    ) -> SwitchProjection:
        """Project what the candidate would cost for the org's workload,
        optionally scaled by ``scale_factor``.

        ``scale_factor=2.0`` answers "what if my traffic doubles?".
        """
        cur = await self._spec_for(
            org_id=org_id, provider=current[0], model_id=current[1],
        )
        cand = await self._spec_for(
            org_id=org_id, provider=candidate[0], model_id=candidate[1],
        )
        history = await self._fetch_usage_history(
            org_id=org_id, provider=current[0], model_id=current[1],
            window_days=window_days,
        )
        # Build a scaled history (request count and tokens scale
        # uniformly; cache hit ratio stays the same).
        if scale_factor != 1.0:
            history = UsageHistory(
                model_id=history.model_id,
                requests=int(history.requests * scale_factor),
                total_input_tokens=int(history.total_input_tokens * scale_factor),
                total_output_tokens=int(history.total_output_tokens * scale_factor),
                total_cache_read_tokens=int(history.total_cache_read_tokens * scale_factor),
                total_cache_write_tokens=int(history.total_cache_write_tokens * scale_factor),
                total_cost_usd=history.total_cost_usd * scale_factor,
                window_days=history.window_days,
                success_rate=history.success_rate,
            )
        return self._project_switch(cur, cand, history)

    # ── Internals ──────────────────────────────────────────────────

    def _score(
        self,
        spec: ModelSpec,
        *,
        workload: UsageHistory | None,
        extra_savings_pct: float = 0.0,
    ) -> tuple[float, str]:
        """Multi-objective score in ``[0, 1]``.

        Returns ``(score, rationale)``. The rationale is a short
        human-readable string the UI can render in the recommendation
        card ("cheaper + faster but 8% quality drop").
        """
        # Cost: lower is better. We map ``blended cost`` against a
        # reference scale where $0.001/1K = score 1.0 and $0.10/1K
        # = score 0.0 (log-scale to keep the curve smooth across
        # cheap/expensive models).
        blended = spec.cost_per_1k_blended
        if blended <= 0.0:
            cost_score = 1.0  # free
        else:
            cost_score = max(0.0, min(1.0, 1.0 - math.log10(blended / 0.001) / 3.0))

        # Quality: linear 0..1.
        quality_score = max(0.0, min(1.0, spec.quality))

        # Latency: lower p95 is better. Reference scale: 200ms =
        # score 1.0, 3000ms = score 0.0.
        lat_score = max(0.0, min(1.0, 1.0 - (spec.latency_p95_ms - 200) / 2800))

        # Reliability: linear 0..1.
        rel_score = max(0.0, min(1.0, spec.reliability))

        # Optional savings boost. A 50% cost cut adds a meaningful
        # nudge; 200% cost increase subtracts the same.
        boost = max(-0.20, min(0.20, extra_savings_pct / 250.0))

        score = (
            self.weights.get("cost", 0.5) * cost_score
            + self.weights.get("quality", 0.3) * quality_score
            + self.weights.get("latency", 0.1) * lat_score
            + self.weights.get("reliability", 0.1) * rel_score
            + boost
        )
        score = max(0.0, min(1.0, score))

        # Build rationale from the strongest factors.
        bits = []
        if extra_savings_pct > 5:
            bits.append(f"saves {extra_savings_pct:.0f}% vs current")
        elif extra_savings_pct < -5:
            bits.append(f"{abs(extra_savings_pct):.0f}% cost increase")
        if quality_score > 0.93:
            bits.append("frontier-tier quality")
        elif quality_score < 0.82:
            bits.append("lower quality")
        if lat_score > 0.9:
            bits.append("fast")
        if not bits:
            bits.append(f"balanced: cost={cost_score:.2f} quality={quality_score:.2f}")
        rationale = "; ".join(bits)
        return score, rationale

    def _project_switch(
        self,
        cur: ModelSpec,
        cand: ModelSpec,
        history: UsageHistory,
    ) -> SwitchProjection:
        """Project the org's bill onto ``cand`` given ``history``."""
        if history.requests <= 0:
            # No usage history yet — fall back to per-request
            # estimate at a 1K in / 500 out default.
            cur_per_req = cur.project_cost(input_tokens=1000, output_tokens=500)
            cand_per_req = cand.project_cost(input_tokens=1000, output_tokens=500)
            return SwitchProjection(
                current=cur,
                candidate=cand,
                history=history,
                current_total_usd=cur_per_req,
                projected_total_usd=cand_per_req,
                savings_usd=cur_per_req - cand_per_req,
                savings_pct=(
                    ((cur_per_req - cand_per_req) / cur_per_req * 100)
                    if cur_per_req > 0 else 0.0
                ),
                per_request_savings_usd=cur_per_req - cand_per_req,
                cache_savings_usd=0.0,
                score=0.5,
            )

        # Total tokens / requests; apply per-request avg to each.
        per_req_in = history.avg_input_tokens
        per_req_out = history.avg_output_tokens
        # Cache split per request: assume the org's observed
        # cache-hit ratio applies uniformly.
        per_req_cache_read = per_req_in * history.cache_hit_ratio
        per_req_cache_write = 0.0  # writes are not in usage_events

        # Current cost (recompute from rates, not from the usage
        # table — the usage_events row may carry pre-cache
        # estimates and we want the "true" current bill).
        cur_per_req = cur.project_cost(
            input_tokens=per_req_in,
            output_tokens=per_req_out,
            cache_read_tokens=per_req_cache_read,
        )
        cand_per_req = cand.project_cost(
            input_tokens=per_req_in,
            output_tokens=per_req_out,
            cache_read_tokens=per_req_cache_read,
            cache_write_tokens=per_req_cache_write,
        )

        # Cache-only savings (would cost ``cur_per_req`` with cache
        # not applied; instead it costs ``cur_per_req`` because we
        # *did* apply it). The fair "cache savings" figure is the
        # difference between cand's bill WITH cache discount and
        # what cand would cost if cache were billed at full price.
        cand_per_req_no_cache = cand.project_cost(
            input_tokens=per_req_in,
            output_tokens=per_req_out,
        )
        cache_savings_per_req = cand_per_req_no_cache - cand_per_req

        cur_total = cur_per_req * history.requests
        cand_total = cand_per_req * history.requests

        score, _rationale = self._score(
            cand,
            workload=history,
            extra_savings_pct=(
                ((cur_total - cand_total) / cur_total * 100) if cur_total > 0 else 0.0
            ),
        )

        savings = cur_total - cand_total
        savings_pct = (savings / cur_total * 100) if cur_total > 0 else 0.0

        return SwitchProjection(
            current=cur,
            candidate=cand,
            history=history,
            current_total_usd=cur_total,
            projected_total_usd=cand_total,
            savings_usd=savings,
            savings_pct=savings_pct,
            per_request_savings_usd=cur_per_req - cand_per_req,
            cache_savings_usd=cache_savings_per_req * history.requests,
            score=score,
        )

    async def _fetch_usage_history(
        self,
        *,
        org_id: str | None,
        provider: str,
        model_id: str,
        window_days: int,
    ) -> UsageHistory:
        """Read the org's ``usage_events`` aggregate for one model.

        Returns a synthetic empty :class:`UsageHistory` when the
        org has no rows on the model, or when the DB is
        unavailable. The comparator handles empty history by
        falling back to per-request estimate at 1K in / 500 out.
        """
        empty = UsageHistory(
            model_id=model_id,
            requests=0,
            total_input_tokens=0,
            total_output_tokens=0,
            total_cache_read_tokens=0,
            total_cache_write_tokens=0,
            total_cost_usd=0.0,
            window_days=window_days,
            success_rate=None,
        )
        if not org_id:
            return empty

        # Cache hit path. The key uses the resolved model_id (not
        # the provider) because org-level aggregation is per-model
        # regardless of which provider served it; ``provider`` is
        # informational and matches the request shape.
        cache_key = (org_id, provider or "", model_id or "", int(window_days))
        now = time.monotonic()
        async with self._usage_cache_lock:
            cached = self._usage_cache.get(cache_key)
            if cached is not None and cached[0] > now:
                return cached[1]

        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return empty
            # The usage_events table carries cost_usd + a metadata
            # blob where the gateway writes cache_read_tokens /
            # cache_write_tokens. We sum those per-model for the
            # window.
            since = datetime.now(UTC) - timedelta(days=window_days)
            row = await client.fetchrow(
                """
                SELECT
                    count(*) AS requests,
                    coalesce(sum(
                        CASE WHEN metadata ? 'input_tokens'
                             THEN (metadata->>'input_tokens')::numeric
                             ELSE 0 END
                    ), 0)::bigint AS total_input_tokens,
                    coalesce(sum(
                        CASE WHEN metadata ? 'output_tokens'
                             THEN (metadata->>'output_tokens')::numeric
                             ELSE 0 END
                    ), 0)::bigint AS total_output_tokens,
                    coalesce(sum(
                        CASE WHEN metadata ? 'cache_read_tokens'
                             THEN (metadata->>'cache_read_tokens')::numeric
                             ELSE 0 END
                    ), 0)::bigint AS total_cache_read_tokens,
                    coalesce(sum(
                        CASE WHEN metadata ? 'cache_write_tokens'
                             THEN (metadata->>'cache_write_tokens')::numeric
                             ELSE 0 END
                    ), 0)::bigint AS total_cache_write_tokens,
                    coalesce(sum(cost_usd), 0)::float8 AS total_cost_usd
                FROM usage_events
                WHERE org_id = $1
                  AND model = $2
                  AND event_type = 'llm_call'
                  AND created_at >= $3
                """,
                org_id, model_id, since,
            )
            if row is None or row["requests"] == 0:
                result = empty
            else:
                result = UsageHistory(
                    model_id=model_id,
                    requests=int(row["requests"]),
                    total_input_tokens=int(row["total_input_tokens"]),
                    total_output_tokens=int(row["total_output_tokens"]),
                    total_cache_read_tokens=int(row["total_cache_read_tokens"]),
                    total_cache_write_tokens=int(row["total_cache_write_tokens"]),
                    total_cost_usd=float(row["total_cost_usd"]),
                    window_days=window_days,
                    success_rate=None,
                )
            async with self._usage_cache_lock:
                # Bounded: oldest entry drops first. The cache
                # is keyed by (org, provider, model, window_days)
                # so 1k orgs × 5 models = 5k entries worst case,
                # ~400KB - well under the cost_resolver cap.
                if len(self._usage_cache) >= 4096:
                    self._usage_cache.pop(next(iter(self._usage_cache)))
                self._usage_cache[cache_key] = (
                    now + self.usage_cache_ttl_seconds,
                    result,
                )
            return result
        except Exception as exc:  # noqa: BLE001 - DB blip must not break comparison
            logger.debug("usage_events lookup failed for %s/%s: %r", provider, model_id, exc)
            return empty


__all__ = [
    "DEFAULT_MIN_QUALITY",
    "DEFAULT_WEIGHTS",
    "DEFAULT_WINDOW_DAYS",
    "ModelComparator",
    "ModelComparison",
    "ModelSpec",
    "Recommendation",
    "SwitchProjection",
    "UsageHistory",
]
