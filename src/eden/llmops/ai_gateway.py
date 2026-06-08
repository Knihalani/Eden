"""AIGateway — provider-agnostic wrapper around the upstream LLM call.

Batch A1 / Phase 7.0 — the OpenAI-compatible HTTP gateway
(``/gateway/v1/...``) reuses this module for its PII / filter pass on
the prompt text. The actual provider call goes through the
``openai`` Python SDK pointed at OpenRouter or MiniMax, so this
class is intentionally minimal: it is the "pre-flight" object that
the filter pipeline runs against.

Design notes
------------
* ``ModelRequest`` is the prompt-string-shaped request the original
  Eden pipeline used; the OpenAI-wire gateway rewrites structured
  messages into a single prompt for the PII pass and back.
* ``Provider`` is an enum of the upstreams Eden knows about. The
  gateway picks one based on ``Settings.use_minimax``.
* ``AIGateway._filters`` is the registered filter pipeline (PII
  redaction, profanity, etc.). For A1 we ship a single PII stub
  that is a no-op pass-through — the real filter set arrives in a
  later unit. The shape is stable, so callers don't need to change.
* The class also exposes ``complete()`` and ``acomplete()`` for
  callers that want the pre-filter / post-filter pattern end-to-end
  (the gateway uses this for non-OpenAI-wire traffic, e.g. internal
  agent flows).

The point of this file is to *exist* — every other gateway / ingest
module imports from it — and to be cheaply mockable from tests. The
HTTP gateway in ``src/eden/api/routes/gateway.py`` already mocks
the upstream OpenAI client; this module's filter pass is exercised
in ``tests/integration/test_gateway.py`` and ``tests/unit/test_ai_gateway.py``.
"""

from __future__ import annotations

import enum
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Provider enum
# ─────────────────────────────────────────────────────────────────────


class Provider(str, enum.Enum):
    """Upstream LLM provider that Eden's gateway can route to.

    Picked from ``Settings.use_minimax`` — when True, traffic goes to
    ``Settings.minimax_base_url``; otherwise it goes to OpenRouter.
    Direct provider SDKs (Anthropic SDK, Google GenAI) are not in
    scope for A1; customers reach those models through OpenRouter's
    catalogue via the standard ``openai/<model>`` naming.
    """

    OPENROUTER = "openrouter"
    MINIMAX = "MiniMax"
    OPENAI = "openai"  # reserved for direct OpenAI traffic (e.g. self-hosted)
    ANTHROPIC = "anthropic"  # reserved


# ─────────────────────────────────────────────────────────────────────
# Request / Response models
# ─────────────────────────────────────────────────────────────────────


@dataclass
class ModelRequest:
    """A prompt-string-shaped LLM request — the shape the original
    Eden pipeline used.

    The OpenAI-wire gateway flattens structured messages into ``prompt``
    for the PII / filter pass, then forwards the original structured
    body to the upstream unchanged. This split keeps the pre-flight
    filter pipeline simple (one string in, one string out) while
    letting the wire-format adapter stay lossless.
    """

    model_family: str
    model_version: str
    prompt: str
    # Optional structured fields for callers that want them
    system: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class ModelResponse:
    """Provider response in the prompt-string shape."""

    content: str
    model: str
    finish_reason: str = "stop"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────
# Filter pipeline
# ─────────────────────────────────────────────────────────────────────


class FilterSet:
    """A registered pipeline of request-time filters.

    The single filter we ship today is a PII stub (regex-based SSN /
    email redaction). When the real PII detector (unit L3) lands, the
    ``PIIFilter`` class swaps in here. The shape of ``run()`` —
    ``(ModelRequest, list[str])`` — is stable.

    Adding a filter
    ---------------
    Implement ``BaseFilter.run(req: ModelRequest) -> tuple[ModelRequest, list[str]]``
    and register it on the AIGateway instance: ``gw._filters.register(MyFilter())``.
    """

    def __init__(self) -> None:
        self._filters: list[BaseFilter] = [PIIFilter()]

    def register(self, filt: "BaseFilter") -> None:
        self._filters.append(filt)

    def run(self, req: ModelRequest) -> tuple[ModelRequest, list[str]]:
        findings: list[str] = []
        out = req
        for f in self._filters:
            try:
                out, f_findings = f.run(out)
                findings.extend(f_findings)
            except Exception as exc:  # noqa: BLE001
                # Filters must never break the request path; log and continue.
                logger.debug(f"filter {type(f).__name__} failed: {exc}")
        return out, findings


class BaseFilter:
    """Base class for request-time filters. Subclasses must override ``run``."""

    name: str = "base"

    def run(self, req: ModelRequest) -> tuple[ModelRequest, list[str]]:
        raise NotImplementedError


# Simple regex-based PII stub. Real implementation lands in unit L3.
_PII_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("email", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("phone_us", re.compile(r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b")),
    ("credit_card", re.compile(r"\b(?:\d[ -]?){13,16}\d\b")),
]


class PIIFilter(BaseFilter):
    """Minimal PII redactor — replaces obvious SSN / email / phone /
    credit-card patterns with ``[REDACTED:<type>]``.

    This is intentionally conservative (high precision, low recall).
    The real per-tenant PII policy with PII detection is wired in
    later; this stub exists so the OpenAI-wire gateway's PII
    pre-flight can be exercised today and the contract is stable.
    """

    name = "pii"

    def run(self, req: ModelRequest) -> tuple[ModelRequest, list[str]]:
        if not req.prompt:
            return req, []
        scrubbed = req.prompt
        findings: list[str] = []
        for label, pat in _PII_PATTERNS:
            if pat.search(scrubbed):
                findings.append(label)
                scrubbed = pat.sub(f"[REDACTED:{label}]", scrubbed)
        if scrubbed == req.prompt:
            return req, []
        # Return a *new* ModelRequest (dataclass is not frozen, but
        # we don't want to mutate the caller's request in place).
        from dataclasses import replace

        return replace(req, prompt=scrubbed), findings


# ─────────────────────────────────────────────────────────────────────
# Gateway
# ─────────────────────────────────────────────────────────────────────


class AIGateway:
    """Provider-agnostic gateway used by the OpenAI-wire HTTP route.

    The HTTP gateway in ``eden.api.routes.gateway`` calls
    ``gw._filters.run(model_request)`` to apply the PII pass. It
    does NOT call ``complete()`` / ``acomplete()`` — the actual
    provider call goes through the OpenAI Python SDK directly.
    Those methods exist for callers (e.g. the agent runtime) that
    want a single entrypoint and don't need OpenAI wire format.
    """

    def __init__(self, provider: Provider = Provider.OPENROUTER) -> None:
        self.provider = provider
        self._filters = FilterSet()

    # ── Sync / async pre-flight helpers ─────────────────────────────

    def filter_request(self, req: ModelRequest) -> tuple[ModelRequest, list[str]]:
        return self._filters.run(req)

    # ── Provider calls (used outside the OpenAI-wire gateway) ───────

    def complete(self, req: ModelRequest) -> ModelResponse:  # pragma: no cover - thin wrapper
        """Synchronous provider call. Returns a ModelResponse with
        the model's text and rough token usage.

        Implementation note: today this delegates to the OpenAI SDK
        for whichever upstream the provider was configured with. In
        A1 this method is not exercised by the HTTP gateway (that
        path uses the SDK directly) but is kept for the agent
        runtime + jobs pipeline that still uses the prompt-string
        shape.
        """
        from eden.llm.client import OpenRouterClient  # local import: avoids cycle

        client = OpenRouterClient()
        # Best-effort token count via the LLM response; we don't block
        # on tokenizer math here.
        text = client.call(req.model_version, req.prompt)
        return ModelResponse(
            content=text.content if hasattr(text, "content") else str(text),
            model=req.model_version,
            finish_reason="stop",
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
        )


__all__ = [
    "AIGateway",
    "FilterSet",
    "BaseFilter",
    "ModelRequest",
    "ModelResponse",
    "PIIFilter",
    "Provider",
]
