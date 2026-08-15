"""SDK wrapper for Eden's model comparison + recommendation API.

The advisor lets a Python agent query the same
:class:`eden.llmops.model_comparator.ModelComparator` that powers
the portal's "switch to save $X" widgets — but from inside the
agent's own code. Typical uses:

* **Pre-flight cost check** before committing to a model in a
  multi-agent pipeline::

      advisor = eden.ModelAdvisor()
      rec = advisor.recommend(org_id="org_123", candidates=[
          ("openai", "gpt-4o"),
          ("anthropic", "claude-sonnet-4-6"),
      ])
      if rec.score < 0.6:
          raise RuntimeError("no candidate clears quality bar")

* **Project cost of a switch** before flipping the agent to a
  new model::

      proj = advisor.project(org_id="org_123",
                             current=("openai", "gpt-4o"),
                             candidate=("anthropic", "claude-sonnet-4-6"))
      if proj.savings_pct > 20:
          log.info("switching saves %.0f%% monthly", proj.savings_pct)

* **Side-by-side compare** for an A/B eval::

      cmp = advisor.compare(org_id="org_123",
                            current=("openai", "gpt-4o"),
                            candidate=("openai", "gpt-4o-mini"))
      log.info("quality delta: %+.2f", cmp.delta_quality)

Auth
----
The advisor reuses the SDK's :class:`EdenConfig` (set via
:func:`eden.configure`) for the org id + API key + base URL. It
sends ``X-Org-Api-Key`` + ``X-Org-Id`` (matching the telemetry
client), not a Bearer-only Authorization header. It also accepts
an explicit ``base_url`` override for customers running their own
Eden instance.

Errors
------
Any HTTP failure surfaces as :class:`ModelAdvisorError` with the
status code + a short reason so callers can decide whether to
fall back, retry, or abort.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

import httpx

from eden_sdk.client import _USER_AGENT
from eden_sdk.config import EdenConfig, get_config

logger = logging.getLogger("eden_sdk.model_advisor")


class ModelAdvisorError(Exception):
    """Raised when the Eden model-advisor API returns an error.

    Attributes
    ----------
    status_code:
        HTTP status from the API. ``0`` for transport-level failures
        (DNS, connection refused, timeout).
    reason:
        Short human-readable explanation. For 4xx errors this is
        the API's ``detail`` field; for 5xx it's the status name.
    body:
        Raw response body, when available. Useful for debugging
        422 validation errors that include field paths.
    """

    def __init__(self, status_code: int, reason: str, body: Any = None) -> None:
        super().__init__(f"{status_code} {reason}")
        self.status_code = status_code
        self.reason = reason
        self.body = body


# ─────────────────────────────────────────────────────────────────────
# Public data shapes
# ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ModelSpec:
    """Static + rate-card metadata for one model."""
    provider: str
    model_id: str
    quality: float
    latency_p95_ms: int
    reliability: float
    context_window: int
    cost_per_1k_input: float
    cost_per_1k_output: float
    cost_per_1k_cache_read: float | None
    cost_per_1k_cache_write: float | None
    source: str

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> ModelSpec:
        return cls(
            provider=payload["provider"],
            model_id=payload["model_id"],
            quality=float(payload["quality"]),
            latency_p95_ms=int(payload["latency_p95_ms"]),
            reliability=float(payload["reliability"]),
            context_window=int(payload["context_window"]),
            cost_per_1k_input=float(payload["cost_per_1k_input"]),
            cost_per_1k_output=float(payload["cost_per_1k_output"]),
            cost_per_1k_cache_read=(
                float(payload["cost_per_1k_cache_read"])
                if payload.get("cost_per_1k_cache_read") is not None
                else None
            ),
            cost_per_1k_cache_write=(
                float(payload["cost_per_1k_cache_write"])
                if payload.get("cost_per_1k_cache_write") is not None
                else None
            ),
            source=str(payload["source"]),
        )


@dataclass(frozen=True)
class ModelComparison:
    """Side-by-side comparison returned by :meth:`ModelAdvisor.compare`."""
    current: ModelSpec
    candidate: ModelSpec
    delta_cost_per_1k_input: float
    delta_cost_per_1k_output: float
    delta_quality: float
    delta_latency_p95_ms: int
    delta_reliability: float
    cost_ratio: float

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> ModelComparison:
        return cls(
            current=ModelSpec.from_api(payload["current"]),
            candidate=ModelSpec.from_api(payload["candidate"]),
            delta_cost_per_1k_input=float(payload["delta_cost_per_1k_input"]),
            delta_cost_per_1k_output=float(payload["delta_cost_per_1k_output"]),
            delta_quality=float(payload["delta_quality"]),
            delta_latency_p95_ms=int(payload["delta_latency_p95_ms"]),
            delta_reliability=float(payload["delta_reliability"]),
            cost_ratio=float(payload["cost_ratio"]),
        )


@dataclass(frozen=True)
class SwitchProjection:
    """Cost projection for a model switch, returned by :meth:`ModelAdvisor.project`."""
    current_provider: str
    current_model_id: str
    candidate_provider: str
    candidate_model_id: str
    current_total_usd: float
    projected_total_usd: float
    savings_usd: float
    savings_pct: float
    per_request_savings_usd: float
    cache_savings_usd: float
    window_days: int
    requests_in_window: int

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> SwitchProjection:
        return cls(
            current_provider=payload["current_provider"],
            current_model_id=payload["current_model_id"],
            candidate_provider=payload["candidate_provider"],
            candidate_model_id=payload["candidate_model_id"],
            current_total_usd=float(payload["current_total_usd"]),
            projected_total_usd=float(payload["projected_total_usd"]),
            savings_usd=float(payload["savings_usd"]),
            savings_pct=float(payload["savings_pct"]),
            per_request_savings_usd=float(payload["per_request_savings_usd"]),
            cache_savings_usd=float(payload["cache_savings_usd"]),
            window_days=int(payload["window_days"]),
            requests_in_window=int(payload["requests_in_window"]),
        )


@dataclass(frozen=True)
class RunnerUp:
    """One runner-up model in a recommendation."""
    provider: str
    model_id: str
    score: float
    rationale: str

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> RunnerUp:
        return cls(
            provider=payload["provider"],
            model_id=payload["model_id"],
            score=float(payload["score"]),
            rationale=str(payload["rationale"]),
        )


@dataclass(frozen=True)
class Recommendation:
    """A recommendation returned by :meth:`ModelAdvisor.recommend`."""
    recommended_provider: str
    recommended_model_id: str
    score: float
    rationale: str
    monthly_savings_usd: float | None
    current_provider: str | None
    current_model_id: str | None
    runners_up: list[RunnerUp]
    empty_history: bool

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> Recommendation:
        return cls(
            recommended_provider=payload["recommended_provider"],
            recommended_model_id=payload["recommended_model_id"],
            score=float(payload["score"]),
            rationale=str(payload["rationale"]),
            monthly_savings_usd=(
                float(payload["monthly_savings_usd"])
                if payload.get("monthly_savings_usd") is not None
                else None
            ),
            current_provider=payload.get("current_provider"),
            current_model_id=payload.get("current_model_id"),
            runners_up=[
                RunnerUp.from_api(r) for r in payload.get("runners_up", [])
            ],
            empty_history=bool(payload.get("empty_history", False)),
        )

    @property
    def recommended_model(self) -> tuple[str, str]:
        """``(provider, model_id)`` tuple for easy destructuring."""
        return (self.recommended_provider, self.recommended_model_id)


# ─────────────────────────────────────────────────────────────────────
# ModelAdvisor
# ─────────────────────────────────────────────────────────────────────


class ModelAdvisor:
    """Client for Eden's model comparison + recommendation API.

    Construct with an explicit :class:`EdenConfig` or omit to use
    the SDK's process-wide config (set via :func:`eden.configure`).

    The advisor is stateless and thread-safe; reuse a single
    instance across requests.

    Examples
    --------
    >>> advisor = eden.ModelAdvisor()
    >>> rec = advisor.recommend(org_id="org_123", candidates=[
    ...     ("openai", "gpt-4o"),
    ...     ("openai", "gpt-4o-mini"),
    ... ])
    >>> print(rec.recommended_model_id)
    gpt-4o-mini

    >>> proj = advisor.project(
    ...     org_id="org_123",
    ...     current=("openai", "gpt-4o"),
    ...     candidate=("anthropic", "claude-sonnet-4-6"),
    ... )
    >>> print(f"save {proj.savings_pct:.0f}% monthly")
    """

    def __init__(
        self,
        *,
        config: EdenConfig | None = None,
        base_url: str | None = None,
        timeout: float = 10.0,
        client: httpx.Client | None = None,
    ) -> None:
        cfg = config or get_config()
        # Base URL precedence: explicit override > config.base_url
        # > Eden public default. Strip any trailing slash.
        self.base_url = (
            base_url
            or getattr(cfg, "base_url", None)
            or "https://api.edenobservability.com"
        ).rstrip("/")
        self.api_key = getattr(cfg, "api_key", "") or ""
        self.org_id = getattr(cfg, "org_id", "") or ""
        self.timeout = timeout
        # Caller can pass a pre-built httpx.Client to reuse
        # connection pooling across calls; otherwise we lazily
        # build one on first use and reuse it. Building per
        # request would defeat HTTP keep-alive and add ~10ms
        # of TLS handshake per call.
        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            self._client = None
            self._owns_client = True
        # Guards lazy client creation so two threads don't
        # both build their own connection pool.
        self._client_lock = threading.Lock()

    def _headers(self) -> dict[str, str]:
        h = {
            "Content-Type": "application/json",
            # Reuse the same User-Agent the telemetry client sends
            # on every ingestion POST so the advisor and the
            # auto-instrumentation paths always report the same
            # SDK version. The previous hardcoded string had no
            # version, so version attribution for advisor traffic
            # was permanently pinned to a literal.
            "User-Agent": _USER_AGENT,
        }
        # Match telemetry / gateway auth: X-Org-Api-Key + X-Org-Id
        # (not Bearer-only). Backend deps accept either shape; the
        # org-key pair is the canonical programmatic credential.
        if self.org_id:
            h["X-Org-Id"] = self.org_id
        if self.api_key:
            h["X-Org-Api-Key"] = self.api_key
        return h

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        # Lazily create a persistent client on first use so the
        # connection pool survives across calls. The client is
        # closed in :meth:`close` or via the context manager.
        # Double-checked locking so the fast path stays lock-free.
        if self._client is None:
            with self._client_lock:
                if self._client is None and self._owns_client:
                    self._client = httpx.Client(timeout=self.timeout)
        try:
            r = self._client.post(url, json=body, headers=self._headers())
        except httpx.HTTPError as exc:
            raise ModelAdvisorError(
                status_code=0,
                reason=f"transport error: {exc!r}",
            ) from exc
        if r.status_code >= 400:
            # Try to surface the API's detail message.
            try:
                err_body: Any = r.json()
                reason = err_body.get("detail") if isinstance(err_body, dict) else str(err_body)
                if not reason:
                    reason = r.reason_phrase or "unknown error"
            except Exception:
                reason = r.reason_phrase or "unknown error"
                err_body = r.text
            raise ModelAdvisorError(
                status_code=r.status_code, reason=str(reason), body=err_body,
            )
        # A 200 with an empty body is almost always a proxy/gateway
        # misconfiguration (interrupted chunked response, missing
        # ``Content-Type``, or a backend that swallowed the
        # reply). ``r.json()`` on an empty body raises a raw
        # ``json.JSONDecodeError`` that propagates up as a
        # confusing traceback — the caller has no way to tell
        # the difference between "server returned nothing" and
        # "the server gave us garbage". Surface a typed
        # ``ModelAdvisorError`` so the caller can show a clear
        # message and the rest of the retry / circuit-breaker
        # logic can react.
        if not r.content:
            raise ModelAdvisorError(
                status_code=r.status_code,
                reason="empty response body",
                body=None,
            )
        return r.json()

    # ── Public methods ─────────────────────────────────────────────

    def compare(
        self,
        *,
        org_id: str,
        current: tuple[str, str],
        candidate: tuple[str, str],
    ) -> ModelComparison:
        """Side-by-side compare two models. Honours per-tenant overrides.

        Parameters
        ----------
        org_id:
            The tenant's org id.
        current, candidate:
            ``(provider, model_id)`` tuples.
        """
        body = {
            "current": {"provider": current[0], "model_id": current[1]},
            "candidate": {"provider": candidate[0], "model_id": candidate[1]},
        }
        resp = self._post(f"/orgs/{org_id}/models/compare", body)
        return ModelComparison.from_api(resp)

    def recommend(
        self,
        *,
        org_id: str,
        candidates: Iterable[tuple[str, str]],
        current: tuple[str, str] | None = None,
        window_days: int = 30,
    ) -> Recommendation:
        """Recommend the best model.

        When ``current`` is given, runs in ``switch`` mode: pulls
        the org's actual usage history and projects cost savings
        on each candidate. When omitted, runs in ``pick`` mode:
        pure ranking.
        """
        cand_list = [
            {"provider": p, "model_id": m} for (p, m) in candidates
        ]
        if not cand_list:
            raise ValueError("candidates must contain at least one model")
        body: dict[str, Any] = {
            "mode": "switch" if current is not None else "pick",
            "candidates": cand_list,
            "window_days": window_days,
        }
        if current is not None:
            body["current"] = {"provider": current[0], "model_id": current[1]}
        resp = self._post(f"/orgs/{org_id}/models/recommend", body)
        return Recommendation.from_api(resp)

    def project(
        self,
        *,
        org_id: str,
        current: tuple[str, str],
        candidate: tuple[str, str],
        scale_factor: float = 1.0,
        window_days: int = 30,
    ) -> SwitchProjection:
        """Project what a model switch would cost the org.

        ``scale_factor`` lets the caller ask "what if traffic
        doubles?" — pass ``2.0`` to scale the org's recent usage
        by 2x and recompute the projected bill.
        """
        body = {
            "current": {"provider": current[0], "model_id": current[1]},
            "candidate": {"provider": candidate[0], "model_id": candidate[1]},
            "scale_factor": scale_factor,
            "window_days": window_days,
        }
        resp = self._post(f"/orgs/{org_id}/models/project", body)
        return SwitchProjection.from_api(resp)

    def close(self) -> None:
        """Release the underlying httpx client (only if we own it)."""
        if self._owns_client and self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> ModelAdvisor:
        """Context-manager support: ``with ModelAdvisor() as advisor: ...``."""
        return self

    def __exit__(self, *exc: object) -> None:
        """Release the underlying httpx client on context exit."""
        self.close()


__all__ = [
    "ModelAdvisor",
    "ModelAdvisorError",
    "ModelComparison",
    "ModelSpec",
    "Recommendation",
    "RunnerUp",
    "SwitchProjection",
]
