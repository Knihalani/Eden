"""Shared helpers for Cat 10 (Governance Intelligence) services.

Centralises:

* Envelope shape — :func:`_ok_envelope`,
  :func:`_bad_request_envelope`. Both use ``live=True`` so the
  front-end renders the same way it does for the other shipped
  cats (Cat 8 / Cat 9 / Cat 11).
* The Postgres client helper — :func:`_get_client`. Mirrors the
  pattern in :mod:`eden.services.user_intel._common` and
  :mod:`eden.services.cost_intel._common`.
* :func:`_new_id` — generates prefixed ids
  (``wf_``, ``req_``, ``ev_``, ``scan_``, ``rtbf_``, ``lin_``,
  ``dash_``) for the various write paths.
* :func:`_now` / :func:`_now_iso` — UTC timestamps.
* :func:`_parse_iso8601` — defensive parser for the
  ``period_start`` / ``period_end`` body fields. Accepts a
  date (``"2026-04-01"``) or a full ISO 8601 datetime; returns
  ``None`` for bad input.
* :func:`_fire_security_violation` — Cat 17
  :meth:`PromotionHook.on_drift_alert` firing for high-severity
  PII findings. Mirrors the Cat 8 / Cat 9 / Cat 11 hook-firing
  pattern (defensive: import + invoke wrapped in try/except).

The helpers are intentionally local to the package — Cat 10 is
self-contained and the package boundary is the right place to
hide the per-service glue.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Public constants ─────────────────────────────────────────────────


#: The two compliance frameworks the
#: :class:`ComplianceEvidenceGenerator` understands.
#:
#: ponytail: per upgradespec §D.5 (Phase 1 cut), HIPAA +
#: ISO27001 were removed. See ``docs/eden-governance-roadmap.md``
#: for the deferred roadmap (HIPAA + ISO27001 ship when an
#: enterprise customer asks).
SUPPORTED_FRAMEWORKS: frozenset[str] = frozenset(
    {"soc2_type_ii", "gdpr"}
)

#: Aliases that map to canonical framework ids. Accepts the
#: short form (``"soc2"``) and the case-insensitive form
#: (``"SOC2"``, ``"GDPR"``) the API spec encourages.
FRAMEWORK_ALIASES: dict[str, str] = {
    "soc2": "soc2_type_ii",
    "soc2_type_2": "soc2_type_ii",
    "soc2_type2": "soc2_type_ii",
    "soc2_type_ii": "soc2_type_ii",
    "gdpr": "gdpr",
    "hipaa": "hipaa",
    "iso27001": "iso27001",
    "iso_27001": "iso27001",
    "iso-27001": "iso27001",
}

#: Per-scanner severity. The API spec calls out ``ssn`` /
#: ``credit_card`` / ``api_keys`` as critical; ``email`` /
#: ``phone`` as high; ``ip_address`` / ``mac_address`` as
#: medium.
SCANNER_SEVERITY: dict[str, str] = {
    "ssn": "high",
    "credit_card": "high",
    "api_keys": "critical",
    "private_key": "critical",
    "aws_secret": "critical",
    "email": "medium",
    "phone": "medium",
    "ip_address": "low",
    "mac_address": "low",
    # "phi" / "passport" / "iban" are HIPAA / EU-specific and
    # were removed per upgradespec §D.5; ship them when the
    # deferred frameworks come back online.
}

#: Default scanner set when the caller doesn't specify one.
#: Drops PHI / passport / IBAN by default (per the appendix:
#: those are HIPAA / EU-specific and need org opt-in).
DEFAULT_SCANNERS: tuple[str, ...] = (
    "ssn", "credit_card", "api_keys", "email", "phone",
)

#: Hard cap on how many events a single scan touches per call.
#: The appendix calls this out as a guardrail against blocking
#: the database for a 1B-event org. Scans run incrementally;
#: callers paginate via ``cursor`` for the next page.
SCAN_PAGE_MAX: int = 10_000

#: Default approval TTL when the caller doesn't pass
#: ``ttl_seconds`` (1 hour). Matches the appendix default.
DEFAULT_APPROVAL_TTL_SECONDS: int = 3600

#: Department / value column widths. Mirrors the schema in
#: migration 020. Used to truncate user-supplied strings before
#: they hit the column-width check.
NAME_MAX: int = 128
TARGET_MAX: int = 256

#: PII regex set used by :class:`SecurityScanner` when the
#: tenant's ``org_pii_policies`` table is empty or unavailable.
#: Patterns are intentionally conservative — false negatives
#: are preferable to false positives that flood the dashboard.
#: A real tenant supplies their own via ``org_pii_policies``;
#: these are the fall-back.
DEFAULT_PII_PATTERNS: dict[str, str] = {
    # US SSN: 9 digits, dash-separated or solid
    "ssn": r"\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b",
    # Major credit cards — Visa/MC/Amex/Discover prefixes; 13-19 digits
    "credit_card": (
        r"\b(?:4\d{12}(?:\d{3})?"
        r"|5[1-5]\d{14}"
        r"|3[47]\d{13}"
        r"|6(?:011|5\d{2})\d{12})\b"
    ),
    # Generic API key — sk_/pk_/api_key= followed by ≥20 chars
    "api_keys": (
        r"\b(?:sk|pk|api[_-]?key)[_-]?(?:live|test)?[_=]?"
        r"[A-Za-z0-9]{20,}\b"
    ),
    # RSA/EC private keys
    "private_key": r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----",
    # AWS access keys
    "aws_secret": r"\bAKIA[0-9A-Z]{16}\b",
    # Email addresses
    "email": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    # US phone — (xxx) xxx-xxxx or xxx-xxx-xxxx or xxx.xxx.xxxx
    "phone": (
        r"\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b"
    ),
    # IBAN — country code + 2 check digits + 11-30 alphanumerics
    "iban": r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b",
    # PHI: HCPCS / ICD-10 code (G0000 / A00.0)
    "phi": r"\b(?:[A-Z]\d{4}|[A-Z]\d{2}(?:\.\d{1,4})?)\b",
    # Passport — letter + 8 digits (US)
    "passport": r"\b[A-Z]\d{8}\b",
}


# ── ID + time helpers ───────────────────────────────────────────────


def _new_id(prefix: str) -> str:
    """Generate a prefixed id (``wf_…``, ``req_…``, ``ev_…``,
    ``scan_…``, ``rtbf_…``, ``lin_…``, ``dash_…``).
    """
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _now() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now().isoformat()


# ── Envelope helpers ─────────────────────────────────────────────────


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """Live response envelope — same shape as the stub
    :class:`eden.intelligence_envelope.IntelligenceStubResponse`
    so the front-end renders uniformly. ``live=True`` signals a
    real implementation.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_id("gov"),
        "timestamp": _now_iso(),
        "data": data,
    }


def _bad_request_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for invalid input (malformed body, unknown
    framework, bad window). ``status="bad_request"`` so the
    front-end renders 4xx-class messaging without falling back
    to the stub envelope.
    """
    return {
        "status": "bad_request",
        "feature": feature,
        "live": True,
        "trace_id": _new_id("gov"),
        "timestamp": _now_iso(),
        "data": {"message": message},
    }


# ── Date / framework parsing ─────────────────────────────────────────


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _parse_iso8601(value: str | None) -> datetime | None:
    """Parse ``"2026-04-01"`` or ``"2026-04-01T00:00:00Z"`` into a
    timezone-aware UTC datetime. Returns ``None`` on bad input.

    A bare date (no time) defaults to midnight UTC. The trailing
    ``"Z"`` shorthand for UTC is normalised to ``"+00:00"`` since
    Python's :func:`datetime.fromisoformat` only accepted ``"Z"``
    natively from 3.11.
    """
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    if _DATE_RE.match(s):
        s = s + "T00:00:00+00:00"
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _normalize_framework(framework: str | None) -> str | None:
    """Map ``"soc2"``/``"SOC2"``/``"soc2_type_ii"`` to the canonical
    framework id; returns ``None`` for unknown values.
    """
    if not isinstance(framework, str):
        return None
    key = framework.strip().lower().replace(" ", "_")
    return FRAMEWORK_ALIASES.get(key)


# ── Data read paths ──────────────────────────────────────────────────


async def _get_client() -> Any:
    """Best-effort :func:`eden.storage.postgres.get_postgres_client`
    import + await. Returns ``None`` if Postgres isn't available —
    the fetchers and persistence helpers check for ``None`` and
    no-op (services then return the "no data" envelope branch).

    Defensive: any import / await failure is logged at DEBUG and
    swallowed so the route always returns a valid envelope.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("governance_intel: postgres import failed: %s", exc)
        return None
    try:
        client = get_postgres_client()
        # The accessor is either a coroutine (production) or a
        # MagicMock pre-bound to a mock client (tests). Only await
        # if it actually returned a coroutine.
        if hasattr(client, "__await__"):
            return await client
        return client
    except Exception as exc:
        logger.debug(
            "governance_intel: get_postgres_client failed: %s", exc
        )
        return None


async def _maybe_await(value: Any) -> Any:
    """Await ``value`` iff it's awaitable. Lets the tests pass
    plain return values through ``MagicMock.fetch`` / ``execute``
    without forcing every test to wrap in ``AsyncMock``.

    Used by the persistence helpers when they call methods that
    may or may not be async depending on whether the caller is
    production or a test fixture.
    """
    if hasattr(value, "__await__"):
        return await value
    return value


# ── Misc helpers ─────────────────────────────────────────────────────


def _truncate(value: Any, max_len: int) -> str:
    """Coerce ``value`` to string and truncate to ``max_len``.
    The schema columns are ``VARCHAR(128)`` / ``VARCHAR(256)``;
    Postgres would reject longer values, so we clip on the way
    in to keep the route from raising.
    """
    if value is None:
        return ""
    s = str(value)
    if len(s) <= max_len:
        return s
    return s[:max_len]


def _redact_match(value: str, pattern: str) -> str:
    """Replace every match of ``pattern`` in ``value`` with
    ``"***"``. Used by :class:`SecurityScanner` when it
    rewrites a payload after flagging a finding.

    Defensive: a malformed pattern (unlikely — they come from
    :data:`DEFAULT_PII_PATTERNS` or the validated
    ``org_pii_policies`` table) returns ``value`` unchanged.
    """
    try:
        return re.sub(pattern, "***", value)
    except re.error as exc:  # pragma: no cover - defensive
        logger.debug("governance_intel: bad regex %r: %s", pattern, exc)
        return value


# ── Closed-loop hook firing ──────────────────────────────────────────


async def _fire_security_violation(
    org_id: str,
    *,
    scanner: str,
    count: int,
    severity: str,
) -> None:
    """Fire :meth:`PromotionHook.on_drift_alert` for high-severity
    security findings. Per the appendix telemetry table:

    * ``critical`` — fire with ``severity="high"``
    * ``high``     — fire with ``severity="medium"``
    * anything else — no-op (the dashboard still surfaces it,
      but it doesn't warrant paging)

    The ``drift_type`` is ``"security:<scanner>"`` so the
    front-end / audit log can grep for a specific scanner.

    Defensive — the hook is best-effort and must never break the
    scan response. Wrapped in try/except in case the
    closed-loop subsystem is mid-restart or the hook module is
    absent (tests where the import fails).
    """
    if count <= 0:
        return
    if severity == "critical":
        hook_sev = "high"
    elif severity == "high":
        hook_sev = "medium"
    else:
        return
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception as exc:
        logger.debug("governance_intel: hook import failed: %s", exc)
        return
    try:
        hook = get_promotion_hook()
    except Exception as exc:
        logger.debug(
            "governance_intel: get_promotion_hook failed: %s", exc
        )
        return
    try:
        await hook.on_drift_alert(
            org_id,
            drift_type=f"security:{scanner}",
            severity=hook_sev,
        )
    except Exception as exc:
        logger.debug(
            "governance_intel: on_drift_alert failed: %s", exc
        )


async def _fire_compliance_gap(
    org_id: str,
    *,
    framework: str,
    failing_controls: int,
) -> None:
    """Fire :meth:`PromotionHook.on_drift_alert` when a compliance
    evidence pack surfaces failing controls.

    Severity ramps with control-count: ≥10 fails → ``"high"``;
    1-9 fails → ``"medium"``; 0 → no-op.

    ``drift_type="compliance_gap:<framework>"`` so a dashboard
    can drill in by framework.
    """
    if failing_controls <= 0:
        return
    hook_sev = "high" if failing_controls >= 10 else "medium"
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception as exc:
        logger.debug("governance_intel: hook import failed: %s", exc)
        return
    try:
        hook = get_promotion_hook()
    except Exception as exc:
        logger.debug(
            "governance_intel: get_promotion_hook failed: %s", exc
        )
        return
    try:
        await hook.on_drift_alert(
            org_id,
            drift_type=f"compliance_gap:{framework}",
            severity=hook_sev,
        )
    except Exception as exc:
        logger.debug(
            "governance_intel: on_drift_alert failed: %s", exc
        )
