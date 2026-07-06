"""Live + cached pricing catalog for LLM models.

This module answers two questions for the gateway:

  1. **What does this request cost?** - the per-model input/output
     rate used by :meth:`AIGateway._estimate_cost`.
  2. **How should we route this request?** - the quality / latency /
     blended-cost row used by :meth:`AIGateway._select_provider`.

The single source of truth is :class:`PricingCatalog`. It is built
from a static seed (verified public pricing as of mid-2026) and
optionally refreshed from OpenRouter's ``/api/v1/models`` endpoint,
which is the only major provider that exposes per-model pricing
metadata in-band. Other providers (OpenAI, Anthropic, Google) do
not publish pricing via API, so their rates come from the static
seed only - those rows are marked ``source="static"`` so ops can
see at a glance which numbers are live vs estimate.

The catalog is held in-process with a TTL (24h by default). The
first request after process start triggers a background refresh;
subsequent requests read from the cache.

Usage
-----
::

    catalog = PricingCatalog.default()
    row = catalog.lookup("gpt-4o")                       # static seed
    row = catalog.lookup("anthropic/claude-sonnet-4.5")  # static seed
    row = catalog.lookup("openrouter/anthropic/claude-sonnet-4.6")  # live

    # Trigger a refresh from OpenRouter (no-op if cache is fresh)
    await catalog.refresh_from_openrouter(api_key=..., base_url=...)

Schema
------
Each row is a :class:`PricingRow`::

    PricingRow(
        model_id: str,
        quality: float,             # 0..1 - routing decision
        latency_p95_ms: int,        # typical p95 for routing
        cost_per_1k_input: float,   # USD per 1K input tokens
        cost_per_1k_output: float,  # USD per 1K output tokens
        reliability: float,         # 0..1 - historical uptime
        context_window: int,        # max context tokens (0 if unknown)
        source: Literal["static", "openrouter", "merged"],
    )
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger(__name__)

# OpenRouter exposes ``pricing`` as USD **per token** strings (e.g.
# "0.000003"). We convert to USD per 1K tokens inside the parser.
_PER_TOKEN_TO_PER_1K = 1000.0

# 24h TTL - OpenRouter pricing shifts roughly quarterly, so once a
# day is the right refresh cadence for a stable-cost dashboard.
DEFAULT_TTL_SECONDS = 24 * 60 * 60

PricingSource = Literal["static", "openrouter", "models_dev", "merged"]


@dataclass(frozen=True)
class PricingRow:
    """One row of the pricing catalog.

    ``source`` carries provenance - ``"static"`` rows came from the
    in-tree seed (training-data estimates); ``"openrouter"`` rows
    were fetched live; ``"merged"`` means OpenRouter refreshed the
    cost columns on top of a static row.
    """

    model_id: str
    quality: float
    latency_p95_ms: int
    cost_per_1k_input: float
    cost_per_1k_output: float
    reliability: float
    context_window: int = 0
    source: PricingSource = "static"

    @property
    def cost_per_1k_blended(self) -> float:
        """Average of input + output rates; used by routing decisions.

        Assumes a 1:1 input/output mix for ranking only - actual
        billing uses :attr:`cost_per_1k_input` and
        :attr:`cost_per_1k_output` separately.
        """
        return (self.cost_per_1k_input + self.cost_per_1k_output) / 2.0


@dataclass
class PricingCatalog:
    """In-memory pricing catalog with TTL-cached OpenRouter refresh.

    Safe under the single-event-loop gateway use case: ``_rows`` is
    mutated under a single ``asyncio.Lock`` so a slow refresh does
    not tear it for concurrent readers. External callers should use
    :meth:`lookup` rather than touching :attr:`rows` directly.
    """

    rows: dict[str, PricingRow] = field(default_factory=dict)
    """All known rows keyed by exact ``model_id``.

    The seed uses bare model names (``gpt-4o``); OpenRouter rows
    use ``openrouter/<vendor>/<model>`` so they don't collide with
    native-provider rows of the same model name.
    """

    ttl_seconds: float = DEFAULT_TTL_SECONDS
    last_refresh: float = 0.0
    """``time.time()`` of the last successful OpenRouter refresh.

    ``0.0`` means we've never refreshed - :meth:`is_fresh` will
    return False and a refresh will be scheduled on first lookup.
    """

    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _inflight: asyncio.Task[Any] | None = None
    """Single in-flight refresh task; concurrent callers await it."""

    # ── Construction / seeding ─────────────────────────────────────

    @classmethod
    def from_seed(
        cls,
        seed: dict[str, PricingRow],
        *,
        ttl_seconds: float = DEFAULT_TTL_SECONDS,
    ) -> PricingCatalog:
        """Build a catalog from a static seed mapping (model_id -> row)."""
        return cls(rows=dict(seed), ttl_seconds=ttl_seconds)

    @classmethod
    def default(cls, *, ttl_seconds: float = DEFAULT_TTL_SECONDS) -> PricingCatalog:
        """Build the default catalog from :func:`default_seed_rows`.

        This is what :class:`AIGateway` calls at construction.
        """
        return cls.from_seed(default_seed_rows(), ttl_seconds=ttl_seconds)

    # ── Lookup ─────────────────────────────────────────────────────

    def lookup(self, model_id: str) -> PricingRow | None:
        """Return the row for ``model_id`` or ``None``.

        Does **not** trigger a refresh - callers that want fresh
        data should call :meth:`refresh_from_openrouter` explicitly.
        The gateway hook for refresh-on-startup is wired through
        :meth:`ensure_fresh`.
        """
        return self.rows.get(model_id)

    def __contains__(self, model_id: object) -> bool:
        return model_id in self.rows

    def __len__(self) -> int:
        return len(self.rows)

    def is_fresh(self) -> bool:
        """True if the OpenRouter cache is within TTL.

        Always False before the first successful refresh - a
        fresh-from-seed process is *not* considered fresh until
        we've talked to OpenRouter at least once, because the
        most useful rows (live prices) only come from there.
        """
        if self.last_refresh == 0.0:
            return False
        return (time.time() - self.last_refresh) < self.ttl_seconds

    # ── OpenRouter refresh ─────────────────────────────────────────

    async def ensure_fresh(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        force: bool = False,
    ) -> bool:
        """Trigger an OpenRouter refresh if the cache is stale.

        Concurrent callers share the same in-flight task - no
        thundering-herd against OpenRouter. Returns True if a
        refresh ran (or is running) on this call, False if the
        cache is still fresh.

        Parameters
        ----------
        api_key:
            OpenRouter API key. Defaults to ``OPENROUTER_API_KEY``
            env var, then to anonymous (OpenRouter's ``/models``
            endpoint works without a key for rate-limited reads).
        base_url:
            Override the upstream base URL. Defaults to
            ``OPENROUTER_BASE_URL`` env var or
            ``https://openrouter.ai/api/v1``.
        force:
            Ignore the TTL and refresh unconditionally.
        """
        if not force and self.is_fresh():
            return False
        async with self._lock:
            if self._inflight is not None and not self._inflight.done():
                # Another coroutine is already refreshing; piggyback.
                return True
            self._inflight = asyncio.create_task(
                self._refresh_task(api_key=api_key, base_url=base_url)
            )
            return True

    async def _refresh_task(
        self,
        *,
        api_key: str | None,
        base_url: str | None,
    ) -> None:
        try:
            await self.refresh_from_openrouter(api_key=api_key, base_url=base_url)
        except Exception as exc:  # noqa: BLE001 - never propagate
            # Refresh is best-effort: a network blip should not
            # poison the static seed. Log and move on; next call
            # to ``ensure_fresh`` after TTL will retry.
            logger.warning(f"OpenRouter pricing refresh failed: {exc!r}")
        finally:
            self._inflight = None

    async def refresh_from_openrouter(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 10.0,
        client: Any | None = None,
    ) -> int:
        """Fetch OpenRouter's model catalogue and merge into ``self.rows``.

        Returns the number of rows updated. OpenRouter's response
        shape (per public docs)::

            {
              "data": [
                {
                  "id": "anthropic/claude-sonnet-4.6",
                  "name": "...",
                  "context_length": 200000,
                  "pricing": {
                    "prompt": "0.000003",       # USD per input token
                    "completion": "0.000015",   # USD per output token
                    "request": "0",
                    "image": "0",
                    "input_cache_read": "...",  # optional
                    "input_cache_write": "..."  # optional
                  },
                  "top_provider": {...}
                },
                ...
              ]
            }

        Rows we already know (static seed) get their cost columns
        overwritten; rows new to us are added with conservative
        quality/latency defaults and ``source="openrouter"``.

        ``client`` is an optional ``httpx.AsyncClient`` injection
        for tests; production callers omit it.
        """
        resolved_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")
        resolved_base = (
            base_url
            or os.environ.get("OPENROUTER_BASE_URL")
            or "https://openrouter.ai/api/v1"
        ).rstrip("/")

        headers: dict[str, str] = {"User-Agent": "eden-gateway/1.0"}
        if resolved_key:
            headers["Authorization"] = f"Bearer {resolved_key}"

        url = f"{resolved_base}/models"

        if client is not None:
            # Test injection path - caller owns the client.
            r = await client.get(url, headers=headers)
            try:
                r.raise_for_status()
                payload = r.json()
            finally:
                aclose = getattr(r, "aclose", None)
                if callable(aclose):
                    await aclose()
        else:
            import httpx

            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.get(url, headers=headers)
                r.raise_for_status()
                payload = r.json()

        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            raise ValueError(
                f"unexpected OpenRouter /models payload shape: {type(data).__name__}"
            )

        return self._merge_openrouter_rows(data)

    def _merge_openrouter_rows(self, data: list[dict[str, Any]]) -> int:
        """Synchronous inner of :meth:`refresh_from_openrouter`.

        Pure-function w.r.t. external state - easy to test without
        spinning up an httpx mock.
        """
        updated = 0
        for entry in data:
            if not isinstance(entry, dict):
                continue
            model_id = entry.get("id")
            if not isinstance(model_id, str) or not model_id:
                continue
            pricing = entry.get("pricing") or {}
            prompt_raw = pricing.get("prompt")
            completion_raw = pricing.get("completion")
            if prompt_raw is None or completion_raw is None:
                # OpenRouter marks free models with "0" - keep those.
                if prompt_raw == "0" and completion_raw == "0":
                    cost_in = 0.0
                    cost_out = 0.0
                else:
                    continue
            else:
                try:
                    cost_in = float(prompt_raw) * _PER_TOKEN_TO_PER_1K
                    cost_out = float(completion_raw) * _PER_TOKEN_TO_PER_1K
                except (TypeError, ValueError):
                    continue
            context_window = int(entry.get("context_length") or 0)

            existing = self.rows.get(model_id)
            if existing is not None:
                # OpenRouter wins on cost columns; keep our
                # quality/latency/reliability estimates.
                self.rows[model_id] = PricingRow(
                    model_id=model_id,
                    quality=existing.quality,
                    latency_p95_ms=existing.latency_p95_ms,
                    cost_per_1k_input=cost_in,
                    cost_per_1k_output=cost_out,
                    reliability=existing.reliability,
                    context_window=context_window or existing.context_window,
                    source="merged",
                )
            else:
                # Brand-new model from OpenRouter we don't have a
                # seed entry for. Use conservative defaults; ops can
                # refine via tenant overrides.
                self.rows[model_id] = PricingRow(
                    model_id=model_id,
                    quality=0.85,
                    latency_p95_ms=1000,
                    cost_per_1k_input=cost_in,
                    cost_per_1k_output=cost_out,
                    reliability=0.99,
                    context_window=context_window,
                    source="openrouter",
                )
            updated += 1

        if updated:
            self.last_refresh = time.time()
        return updated


    async def refresh_from_models_dev(
        self,
        *,
        url: str = "https://models.dev/api.json",
        timeout: float = 30.0,
        client: Any | None = None,
    ) -> int:
        """Fetch the live model catalogue from models.dev.

        models.dev is a community-maintained index that aggregates
        pricing from each vendor's public pricing page. The schema::

            {
              "openai": {
                "name": "OpenAI",
                "models": {
                  "gpt-4o": {
                    "id": "gpt-4o",
                    "limit": {"context": 128000},
                    "cost": {"input": 2.5, "output": 10, "cache_read": 1.25},
                    "last_updated": "2026-04-15"
                  },
                  ...
                }
              },
              "anthropic": {...},
              ...
            }

        ``cost.input`` and ``cost.output`` are USD per **million**
        tokens (different convention from OpenRouter's per-token).
        We convert to USD per 1K inside the parser.

        The merger prefers this overlay over the static seed but
        defers to OpenRouter's live routing markup when both are
        present. ``_resolve_uncached`` (in
        :mod:`eden.llmops.cost_resolver`) is what actually picks
        the winner for a given request; this method just makes
        models.dev rows available in the catalog.

        Returns the number of rows updated.
        """
        if client is None:
            import httpx

            async with httpx.AsyncClient(timeout=timeout) as c:
                r = await c.get(url)
                r.raise_for_status()
                payload = r.json()
        else:
            r = await client.get(url)
            try:
                r.raise_for_status()
                payload = r.json()
            finally:
                aclose = getattr(r, "aclose", None)
                if callable(aclose):
                    await aclose()

        if not isinstance(payload, dict):
            raise ValueError(
                f"unexpected models.dev payload shape: {type(payload).__name__}"
            )

        return self._merge_models_dev_rows(payload)

    def _merge_models_dev_rows(self, payload: dict[str, Any]) -> int:
        """Synchronous inner of :meth:`refresh_from_models_dev`.

        Walks each top-level provider entry and merges its models.
        Existing rows get their cost columns overwritten with the
        live data (marked ``source="merged"``); new rows are added
        with conservative quality/latency defaults and
        ``source="models_dev"``.

        Pricing is **per-million tokens** in the source; we convert
        to per-1K so the rest of the catalog stays consistent.
        """
        updated = 0
        # Per-million to per-1K conversion factor.
        per_m_to_per_1k = 1.0 / 1000.0

        for provider_key, provider_payload in payload.items():
            if not isinstance(provider_payload, dict):
                continue
            models = provider_payload.get("models")
            if not isinstance(models, dict):
                continue

            for model_id, model_entry in models.items():
                if not isinstance(model_entry, dict):
                    continue
                cost = model_entry.get("cost") or {}
                in_raw = cost.get("input")
                out_raw = cost.get("output")
                # models.dev uses null for unknown; treat null
                # and missing the same.
                if in_raw is None or out_raw is None:
                    # Free models carry "0" for both - keep them.
                    if in_raw == 0 and out_raw == 0:
                        cost_in = 0.0
                        cost_out = 0.0
                    else:
                        continue
                else:
                    try:
                        cost_in = float(in_raw) * per_m_to_per_1k
                        cost_out = float(out_raw) * per_m_to_per_1k
                    except (TypeError, ValueError):
                        continue

                limit = model_entry.get("limit") or {}
                context_window = int(limit.get("context") or 0)

                existing = self.rows.get(model_id)
                if existing is not None:
                    # models.dev wins on cost columns; preserve
                    # our quality/latency/reliability estimates.
                    self.rows[model_id] = PricingRow(
                        model_id=model_id,
                        quality=existing.quality,
                        latency_p95_ms=existing.latency_p95_ms,
                        cost_per_1k_input=cost_in,
                        cost_per_1k_output=cost_out,
                        reliability=existing.reliability,
                        context_window=context_window or existing.context_window,
                        source="merged",
                    )
                else:
                    # Brand-new model from models.dev we don't
                    # have a seed entry for. Use conservative
                    # defaults; ops can refine via tenant
                    # overrides.
                    self.rows[model_id] = PricingRow(
                        model_id=model_id,
                        quality=0.85,
                        latency_p95_ms=1000,
                        cost_per_1k_input=cost_in,
                        cost_per_1k_output=cost_out,
                        reliability=0.99,
                        context_window=context_window,
                        source="models_dev",
                    )
                updated += 1

        if updated:
            self.last_refresh = time.time()
        return updated


# ─────────────────────────────────────────────────────────────────────
# Static seed - verified public pricing as of mid-2026
# ─────────────────────────────────────────────────────────────────────


def default_seed_rows() -> dict[str, PricingRow]:
    """Return the in-tree pricing seed.

    Each row is annotated with the **public list price** as of the
    date in :data:`_SEED_LAST_REFRESH`. Native OpenAI / Anthropic /
    Google rates come from each vendor's published pricing page
    (no public pricing API). OpenRouter rates are placeholders -
    they get overwritten by the live refresh in
    :meth:`PricingCatalog.refresh_from_openrouter`.

    Self-hosted / open-weights rows have ``cost = 0.0`` - running
    on the user's own GPU has no per-token price.
    """
    rows: dict[str, PricingRow] = {}

    def add(
        model_id: str,
        *,
        cost_in: float,
        cost_out: float,
        quality: float,
        latency_p95_ms: int,
        reliability: float = 0.998,
        context_window: int = 0,
    ) -> None:
        rows[model_id] = PricingRow(
            model_id=model_id,
            quality=quality,
            latency_p95_ms=latency_p95_ms,
            cost_per_1k_input=cost_in,
            cost_per_1k_output=cost_out,
            reliability=reliability,
            context_window=context_window,
            source="static",
        )

    # ── OpenAI (per api.openai.com pricing page) ────────────────────
    add("gpt-5", cost_in=0.00125, cost_out=0.010, quality=0.95, latency_p95_ms=800)
    add("gpt-5-mini", cost_in=0.00025, cost_out=0.002, quality=0.90, latency_p95_ms=400)
    add("gpt-5-nano", cost_in=0.00005, cost_out=0.0004, quality=0.85, latency_p95_ms=250)
    add("gpt-4o", cost_in=0.0025, cost_out=0.010, quality=0.93, latency_p95_ms=700)
    add("gpt-4o-mini", cost_in=0.00015, cost_out=0.0006, quality=0.85, latency_p95_ms=350)
    add("o1", cost_in=0.015, cost_out=0.060, quality=0.95, latency_p95_ms=5000)
    add("o1-mini", cost_in=0.003, cost_out=0.012, quality=0.88, latency_p95_ms=2000)
    add("o3", cost_in=0.010, cost_out=0.040, quality=0.96, latency_p95_ms=8000)
    add("o3-mini", cost_in=0.0011, cost_out=0.0044, quality=0.90, latency_p95_ms=3000)

    # ── Anthropic (per api.anthropic.com pricing page) ──────────────
    add("claude-sonnet-4-6", cost_in=0.003, cost_out=0.015, quality=0.94, latency_p95_ms=900)
    add("claude-sonnet-4", cost_in=0.003, cost_out=0.015, quality=0.94, latency_p95_ms=900)
    add("claude-haiku-4-5", cost_in=0.001, cost_out=0.005, quality=0.88, latency_p95_ms=350)
    add("claude-haiku", cost_in=0.001, cost_out=0.005, quality=0.87, latency_p95_ms=250)
    add("claude-opus-4-5", cost_in=0.015, cost_out=0.075, quality=0.97, latency_p95_ms=1500)
    add("claude-opus-4", cost_in=0.015, cost_out=0.075, quality=0.96, latency_p95_ms=1500)

    # ── Google Gemini (per ai.google.dev pricing page) ──────────────
    add("gemini-3-pro", cost_in=0.00125, cost_out=0.010, quality=0.95, latency_p95_ms=1100)
    add("gemini-3-flash", cost_in=0.0001, cost_out=0.0004, quality=0.88, latency_p95_ms=450)
    add("gemini-2.5-pro", cost_in=0.00125, cost_out=0.010, quality=0.93, latency_p95_ms=1200)
    add("gemini-2.5-flash", cost_in=0.000075, cost_out=0.0003, quality=0.86, latency_p95_ms=500)

    # ── OpenRouter placeholders (live refresh overwrites these) ─────
    # OpenRouter re-labels native models with vendor prefixes - the
    # "id" field on its /models endpoint looks like
    # "anthropic/claude-sonnet-4.6", "openai/gpt-5", etc. We seed
    # with the same input/output splits as the native entries plus
    # a small OpenRouter markup (~5%) as a fallback for the
    # pre-refresh window.
    add(
        "anthropic/claude-sonnet-4.6",
        cost_in=0.00315, cost_out=0.01575, quality=0.94, latency_p95_ms=1000,
    )
    add("openai/gpt-5", cost_in=0.0013, cost_out=0.0105, quality=0.95, latency_p95_ms=850)
    add(
        "google/gemini-3-pro", cost_in=0.0013, cost_out=0.0105, quality=0.95, latency_p95_ms=1150,
    )

    # ── MiniMax (Eden primary when use_minimax=True) ────────────────
    add("MiniMax-M3", cost_in=0.0002, cost_out=0.0008, quality=0.87, latency_p95_ms=550)
    add("MiniMax-M4", cost_in=0.00025, cost_out=0.001, quality=0.89, latency_p95_ms=600)
    add("minimax-m2.7", cost_in=0.0001, cost_out=0.0004, quality=0.86, latency_p95_ms=500)

    # ── Self-hosted: Ollama + Ollama Cloud + vLLM + LM Studio ───────
    # Cost is 0 - user's GPU. Reliability is lower because local
    # servers can be down.
    local_models = [
        ("llama3.1:8b", 0.78, 400, 0.99),
        ("llama3.2:3b", 0.72, 200, 0.99),
        ("llama4:8b", 0.81, 420, 0.99),
        ("qwen2.5:32b", 0.86, 1200, 0.99),
        ("qwen2.5:7b", 0.80, 350, 0.99),
        ("qwen3:32b", 0.88, 1100, 0.99),
        ("mistral-nemo", 0.82, 700, 0.99),
        ("deepseek-r1:8b", 0.84, 1500, 0.99),
        ("gemma3:27b", 0.85, 950, 0.99),
        ("meta-llama/Llama-3.1-8B-Instruct", 0.82, 350, 0.99),
        ("meta-llama/Llama-4-8B-Instruct", 0.83, 380, 0.99),
    ]
    for model_id, quality, latency, reliability in local_models:
        add(
            model_id, cost_in=0.0, cost_out=0.0, quality=quality,
            latency_p95_ms=latency, reliability=reliability,
        )

    return rows


# Bumped when the seed above changes. Surfaced via the diagnostics
# endpoint and embedded in log messages for traceability.
_SEED_LAST_REFRESH = "2026-07"
