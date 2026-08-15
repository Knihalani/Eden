"""Shared stub envelope for the 16-category intelligence gap surface.

Every new ``intelligence_*`` route returns one of these
``IntelligenceStubResponse`` instances. It is intentionally minimal
but consistent so the front-end can render stubs uniformly and tests
can assert on the shape.

The envelope makes three promises to callers:

* ``status`` is always present. ``"not_implemented"`` for code that
  raises; ``"ok"`` for routes that do something real (e.g. a guardrail
  ``verdict: "allow"`` default, or a CRU endpoint that records a
  no-op).
* ``feature`` is the name of the stub class. Stable across releases.
* ``live`` is always ``False`` for stubbed behaviour so the UI can
  display a "preview" badge and not silently act on fabricated
  values.
* ``trace_id`` correlates the response to a server-side log entry,
  for debugging.

See ``docs/eden-observability-gap-roadmap.md`` for the full design.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# The umbrella feature flag that gates the entire surface. It is
# intentionally different from the existing per-route flags so the
# whole 16-category scope can be toggled as a unit.
INTELLIGENCE_GAP_FLAG = "intelligence_gap_v0"


def _new_trace_id() -> str:
    return f"stub_{uuid.uuid4().hex[:12]}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class IntelligenceStubResponse(BaseModel):
    """Uniform envelope for every stubbed intelligence route."""

    status: str = Field("not_implemented", description="ok or not_implemented")
    feature: str = Field(..., description="Name of the stub class")
    live: bool = Field(False, description="Always false for stubbed behaviour")
    trace_id: str = Field(default_factory=_new_trace_id)
    timestamp: str = Field(default_factory=_now_iso)
    data: dict[str, Any] | None = None
    message: str | None = None


def stub(
    feature: str,
    *,
    data: dict[str, Any] | None = None,
    message: str | None = None,
    status: str = "not_implemented",
) -> dict[str, Any]:
    """Return the dict form of :class:`IntelligenceStubResponse`.

    Convenience for route handlers that return ``dict`` rather than
    the Pydantic model. Centralised so a future change to the
    envelope is one edit.
    """
    return IntelligenceStubResponse(
        status=status,
        feature=feature,
        data=data,
        message=message,
    ).model_dump()


def not_implemented(feature: str, message: str | None = None) -> dict[str, Any]:
    """The most common stub response: feature declared, not built."""
    logger.debug("intelligence stub hit: %s", feature)
    return stub(feature, message=message or "Stub registered; implementation pending")


def allow_default(feature: str, **data: Any) -> dict[str, Any]:
    """A safe default for guardrail-style routes.

    Routes that *block* a real action (e.g. ``guardrails/evaluate``)
    must not block in stub mode — that would break production
    flows. They return ``status: "ok"`` with a verdict of
    ``"allow"`` and a clear ``live: False`` flag so the front-end
    shows a "preview" badge.
    """
    return stub(feature, data={"verdict": "allow", **data}, status="ok")
