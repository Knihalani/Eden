"""Stable issue fingerprints (F29 ``compute_fingerprint``).

The fingerprint groups stumbles into issues. It is derived from the
stumble kind, the agent, and a per-kind *error signature* extracted from
the stumble ``detail`` payload. Volatile tokens (UUIDs, hex ids, numbers,
timestamps) are stripped so the same logical failure always hashes to the
same value regardless of the specific request.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)
_HEX_RE = re.compile(r"\b[0-9a-f]{16,}\b", re.IGNORECASE)
_NUM_RE = re.compile(r"\b\d+\b")
_WS_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    """Lowercase + strip UUIDs / long hex ids / bare numbers / extra ws."""
    if not text:
        return ""
    out = text.lower()
    out = _UUID_RE.sub("<uuid>", out)
    out = _HEX_RE.sub("<hex>", out)
    out = _NUM_RE.sub("<n>", out)
    out = _WS_RE.sub(" ", out).strip()
    # Cap so a giant stack trace can't dominate the signature.
    return out[:512]


def error_signature_for(kind: str, detail: dict[str, Any]) -> str:
    """Derive a per-kind error signature string from a stumble detail.

    The signature is what makes two stumbles "the same issue":

    * ``tool_error``  → ``{tool_name}|{normalized error message/code}``
    * ``loop``        → the ETEC loop hash (or normalized repeated step)
    * ``task_failure``→ normalized failure reason
    * everything else → normalized ``message`` / ``title`` fallback
    """
    d = detail or {}
    if kind == "tool_error":
        tool = str(d.get("tool_name") or d.get("tool") or "unknown")
        err = str(
            d.get("error_code")
            or d.get("error_type")
            or d.get("error")
            or d.get("message")
            or ""
        )
        return f"{tool.lower()}|{_normalize(err)}"
    if kind == "loop":
        lh = d.get("loop_hash") or d.get("etec_loop_hash")
        if lh:
            return f"loop:{str(lh).lower()}"
        return f"loop:{_normalize(str(d.get('repeated_step') or d.get('message') or ''))}"
    if kind == "task_failure":
        reason = str(
            d.get("failure_reason") or d.get("reason") or d.get("message") or ""
        )
        return _normalize(reason)
    if kind == "mcp_auth_failure":
        server = str(d.get("server") or d.get("mcp_server") or "unknown")
        return f"mcp_auth:{server.lower()}"
    if kind == "statgate_p0":
        check = str(d.get("check") or d.get("p0_check") or "statgate")
        return f"statgate:{check.lower()}"
    # Generic fallback: normalized message/title/reason.
    return _normalize(
        str(d.get("message") or d.get("reason") or d.get("title") or "")
    )


def _fingerprint_agent_key(agent_id: str | None, trace_id: str | None) -> str:
    """Stable agent slot for fingerprint hashing.

    When ``agent_id`` is missing we must not collapse unrelated agents into
    the legacy shared ``"unknown"`` bucket. Prefer a per-trace key so two
    different traces with the same ``(kind, error_signature)`` stay distinct.
    """
    if agent_id:
        return agent_id
    if trace_id:
        return f"__unattributed__:{trace_id}"
    # Last resort for callers without trace context — still avoids the old
    # shared ``"unknown"`` literal that merged every agent-less stumble.
    return "__unattributed__"


def compute_fingerprint(
    kind: str,
    agent_id: str | None,
    error_signature: str,
    *,
    trace_id: str | None = None,
) -> str:
    """Return the 32-char hex fingerprint for ``(kind, agent, signature)``.

    Matches the F29 spec: ``sha256(f"{kind}|{agent}|{sig}")[:32]``.
    ``trace_id`` is used only when ``agent_id`` is missing (see
    :func:`_fingerprint_agent_key`).
    """
    agent_key = _fingerprint_agent_key(agent_id, trace_id)
    raw = f"{kind}|{agent_key}|{error_signature}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
