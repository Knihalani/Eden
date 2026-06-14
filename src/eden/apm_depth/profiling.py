"""Cat 22 — Pyroscope continuous profiling (v1.4).

Per the appendix (`docs/observability-gap/22-apm-tracing-depth.md`
§9) the v1.4 ship lays the **groundwork** for Pyroscope
continuous profiling:

* The :class:`ProfilingClient` generates a deterministic
  correlation ID (``profile_<sha256[:16]>``) for each
  ``(org_id, trace_id, step_index)`` tuple.
* The client persists the correlation ID + the profile
  URL to ``trace_step_profile_links`` (the table Cat 22
  adds in migration 026).
* The client surfaces ``PyroscopeLink`` envelopes that
  the portal renders as "Click for flame graph" links
  on the per-step drill-down.
* The Pyroscope host is configurable
  (``EDEN_PYROSCOPE_HOST`` env, default
  ``http://pyroscope:4040`` — matches the OSS Pyroscope
  default port). Self-hosted OSS Pyroscope is the
  recommended deployment per the appendix ("matches
  Eden's existing self-host posture; no incremental
  cost").

**Why this cat.** When the user sees "step 23 took 2.3s"
on the per-step timeline, the link jumps to a Pyroscope
flame graph showing the exact function in the agent
loop that consumed 80% of the CPU. That's the
"code-level" layer on top of the "trace-level" layer
the rest of Cat 22 ships.

**Sampling rate (per the appendix).** The default is 1%
trace sample rate. The :class:`ProfilingClient` decides
deterministically per trace (SHA-256 of
``trace_id`` < 0.01) so re-runs are reproducible.

**Scope (v0).** The v0 ship does NOT actually push
profiles to Pyroscope — the gateway tier's profile SDK
is a separate PR. The :class:`ProfilingClient` exposes
the URL + correlation ID + sampling-decision surface,
and the portal renders the link. Pushing the profiles
is the v1.4.1 follow-up (the SDK + the gateway
sidecar). The ``is_active: bool`` flag on every link
disambiguates "we generated a correlation ID" from "we
have a real Pyroscope URL".
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

from ._common import _now_iso, _ok_envelope

logger = logging.getLogger(__name__)


# ─── Constants (per the doc) ───────────────────────────────────────

#: The default Pyroscope host. Matches the OSS Pyroscope
#: default port (4040) and the deployment pattern the
#: appendix recommends (self-hosted).
DEFAULT_PYROSCOPE_HOST: str = "http://pyroscope:4040"

#: The default trace sample rate. Per the doc, 1% — the
#: profile-storage cost scales linearly with this knob.
DEFAULT_SAMPLE_RATE: float = 0.01

#: The correlation-id prefix. Matches the rest of the
#: v1.4 surface (e.g. ``exp_<sha256[:16]>`` in Cat 12,
#: ``clu_<sha256[:16]>`` in Cat 2).
PROFILE_ID_PREFIX: str = "profile_"

#: The link-prefix the portal uses to look up the URL.
#: A future v1.4.1 PR wires this to the actual Pyroscope
#: deployment; the v0 ship stores the URL in the
#: ``trace_step_profile_links`` table.
PYROSCOPE_LINK_PREFIX: str = "/apm/profiles"


# ─── Sampling decision (deterministic per trace) ──────────────────


def profile_sample_decision(
    trace_id: str,
    *,
    sample_rate: float = DEFAULT_SAMPLE_RATE,
) -> bool:
    """Return whether the trace should be profiled.

    Deterministic per ``trace_id`` so re-runs of the
    same trace get the same decision (matches the Cat 22
    probabilistic tail-sampling decision). ``sample_rate``
    is clamped to ``[0, 1]``.
    """
    try:
        r = max(0.0, min(1.0, float(sample_rate)))
    except (TypeError, ValueError):
        r = 0.0
    if r <= 0.0:
        return False
    if r >= 1.0:
        return True
    h = hashlib.sha256(str(trace_id or "").encode("utf-8")).hexdigest()
    n = int(h[:8], 16) / 0xFFFFFFFF
    return n < r


def make_profile_id(
    org_id: str,
    trace_id: str,
    step_index: int,
) -> str:
    """Generate the deterministic ``profile_<sha256[:16]>`` id.

    The id is content-derived (matches the rest of the
    v1.4 surface — Cat 2 cluster keys, Cat 12 experiment
    ids) so re-runs of the same ``(org, trace, step)``
    tuple produce the same id and dedupe naturally on
    the ``trace_step_profile_links`` PK.
    """
    payload = f"{org_id}|{trace_id}|{int(step_index)}"
    return f"{PROFILE_ID_PREFIX}{hashlib.sha256(payload.encode('utf-8')).hexdigest()[:16]}"


def build_pyroscope_url(
    pyroscope_host: str,
    *,
    org_id: str,
    trace_id: str,
    step_index: int,
    profile_id: str,
) -> str:
    """Build the Pyroscope query URL the portal renders.

    The URL format matches Pyroscope v0.41+: the
    ``/render`` endpoint with the profile-name + the
    ``from``/``until`` query (the v0 ship uses the
    current time as the upper bound + 1 hour as the
    lower bound). The ``query`` parameter carries the
    ``trace_id=<trace_id>`` tag selector (Pyroscope
    supports arbitrary tag-based drill-down).

    A future v1.4.1 PR swaps the hardcoded time range
    for the actual span's ``start_time`` / ``end_time``.
    """
    host = (pyroscope_host or DEFAULT_PYROSCOPE_HOST).rstrip("/")
    if not host.startswith("http://") and not host.startswith("https://"):
        host = "http://" + host
    now = int(datetime.now(UTC).timestamp())
    query = {
        "name": f"eden.{org_id}.step{step_index}",
        "from": now - 3600,
        "until": now,
        "query": f'{{trace_id="{trace_id}"}}',
    }
    return f"{host}/render?{urlencode(query)}"


# ─── Persistence (best-effort) ─────────────────────────────────────


@dataclass(frozen=True)
class ProfileLink:
    """A persisted profile link row (the API for callers)."""

    id: str
    org_id: str
    trace_id: str
    step_index: int
    profile_id: str
    pyroscope_url: str
    sample_rate: float
    is_active: bool
    created_at: str


async def _persist_link(
    link: ProfileLink,
) -> bool:
    """Best-effort upsert into ``trace_step_profile_links``.

    The PK is ``profile_id`` (the deterministic id) so
    re-runs of the same ``(org, trace, step)`` tuple
    dedupe naturally. Swallows all exceptions.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return False
    try:
        client = await get_postgres_client()
    except Exception:
        return False
    if client is None:
        return False
    try:
        await client.execute(
            """
            INSERT INTO trace_step_profile_links
                (id, org_id, trace_id, step_index, profile_id,
                 pyroscope_url, sample_rate, is_active, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (profile_id) DO UPDATE
              SET pyroscope_url = EXCLUDED.pyroscope_url,
                  sample_rate = EXCLUDED.sample_rate,
                  is_active = EXCLUDED.is_active
            """,
            link.id,
            link.org_id,
            link.trace_id,
            int(link.step_index),
            link.profile_id,
            link.pyroscope_url,
            float(link.sample_rate),
            bool(link.is_active),
        )
        return True
    except Exception as exc:
        logger.debug("trace_step_profile_links upsert failed: %s", exc)
        return False


async def _fetch_link(
    org_id: str,
    *,
    trace_id: str,
    step_index: int,
) -> dict[str, Any] | None:
    """Best-effort fetch from ``trace_step_profile_links``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return None
    try:
        client = await get_postgres_client()
    except Exception:
        return None
    if client is None:
        return None
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, trace_id, step_index, profile_id,
                   pyroscope_url, sample_rate, is_active, created_at
            FROM trace_step_profile_links
            WHERE org_id = $1 AND trace_id = $2 AND step_index = $3
            LIMIT 1
            """,
            org_id, trace_id, int(step_index),
        )
    except Exception as exc:
        logger.debug("trace_step_profile_links fetch failed: %s", exc)
        return None
    for r in rows or []:
        return dict(r) if not isinstance(r, dict) else r
    return None


# ─── The client ────────────────────────────────────────────────────


class ProfilingClient:
    """The Pyroscope profiling client (Cat 22 v1.4).

    The v0 ship:

    * Generates the correlation ID + the Pyroscope URL.
    * Persists the link to ``trace_step_profile_links``
      (best-effort — a postgres outage must not stop
      the link from being returned to the portal).
    * Returns the live ``ok`` envelope with the link
      metadata the portal renders.

    The v1.4.1 follow-up pushes the actual profiles
    (the gateway tier's Pyroscope SDK). The
    ``is_active`` flag on every link disambiguates "we
    have a real Pyroscope URL" from "we generated a
    correlation ID; the URL is the v0 placeholder".
    """

    name = "pyroscope_client"

    def __init__(
        self,
        *,
        pyroscope_host: str | None = None,
        sample_rate: float = DEFAULT_SAMPLE_RATE,
        persist: bool = True,
    ) -> None:
        env_host = os.environ.get("EDEN_PYROSCOPE_HOST", "").strip()
        self.pyroscope_host = (pyroscope_host or env_host or DEFAULT_PYROSCOPE_HOST).rstrip(
            "/"
        )
        try:
            self.sample_rate = max(0.0, min(1.0, float(sample_rate)))
        except (TypeError, ValueError):
            self.sample_rate = DEFAULT_SAMPLE_RATE
        self.persist = bool(persist)

    def _is_active(self) -> bool:
        """Whether the v1.4 gateway SDK is wired up.

        The v0 ship returns ``False`` — the URL is the
        placeholder. The v1.4.1 PR flips this to ``True``
        once the gateway SDK lands.
        """
        # Heuristic: only "active" if the env explicitly
        # opts in. Default is the v0 placeholder.
        return os.environ.get("EDEN_PYROSCOPE_ACTIVE", "").lower() in (
            "1",
            "true",
            "yes",
        )

    async def link_step(
        self,
        org_id: str,
        *,
        trace_id: str,
        step_index: int,
    ) -> dict[str, Any]:
        """Return (and persist) the profile link for a
        ``(trace_id, step_index)`` tuple.

        Returns the live ``ok`` envelope with
        ``data: {"trace_id": ..., "step_index": N,
        "profile_id": ..., "pyroscope_url": ...,
        "sample_rate": float, "is_active": bool,
        "sampled": bool, "link_path": ..., "persisted": bool,
        "created_at": "..."}``. ``sampled`` is False when
        the trace failed the 1% sample rate; in that
        case ``pyroscope_url`` is ``""`` and the portal
        renders "no profile (sampled out)".
        """
        if not isinstance(trace_id, str) or not trace_id:
            return _ok_envelope(
                self.name,
                {
                    "trace_id": trace_id,
                    "step_index": int(step_index) if step_index is not None else 0,
                    "profile_id": "",
                    "pyroscope_url": "",
                    "sample_rate": self.sample_rate,
                    "is_active": False,
                    "sampled": False,
                    "link_path": "",
                    "persisted": False,
                    "created_at": _now_iso(),
                },
            )
        sampled = profile_sample_decision(trace_id, sample_rate=self.sample_rate)
        profile_id = make_profile_id(org_id, trace_id, int(step_index))
        is_active = self._is_active()
        pyroscope_url = (
            build_pyroscope_url(
                self.pyroscope_host,
                org_id=org_id,
                trace_id=trace_id,
                step_index=int(step_index),
                profile_id=profile_id,
            )
            if sampled
            else ""
        )
        link_path = (
            f"{PYROSCOPE_LINK_PREFIX}/{org_id}/{trace_id}/{int(step_index)}"
        )
        persisted = False
        if sampled and self.persist:
            link = ProfileLink(
                id=profile_id,
                org_id=str(org_id or ""),
                trace_id=str(trace_id),
                step_index=int(step_index),
                profile_id=profile_id,
                pyroscope_url=pyroscope_url,
                sample_rate=self.sample_rate,
                is_active=is_active,
                created_at=_now_iso(),
            )
            persisted = await _persist_link(link)
        return _ok_envelope(
            self.name,
            {
                "trace_id": str(trace_id),
                "step_index": int(step_index),
                "profile_id": profile_id,
                "pyroscope_url": pyroscope_url,
                "sample_rate": self.sample_rate,
                "is_active": is_active,
                "sampled": sampled,
                "link_path": link_path,
                "persisted": persisted,
                "created_at": _now_iso(),
            },
        )

    async def get_link(
        self,
        org_id: str,
        *,
        trace_id: str,
        step_index: int,
    ) -> dict[str, Any]:
        """Read the persisted link for a tuple.

        Returns the live ``ok`` envelope. If the row
        doesn't exist (e.g. trace wasn't sampled), the
        ``data`` block has ``pyroscope_url: ""`` and
        ``sampled: false`` — the portal renders "no
        profile" instead of 404-ing.
        """
        row = await _fetch_link(
            org_id, trace_id=trace_id, step_index=step_index
        )
        if not row:
            return _ok_envelope(
                self.name,
                {
                    "trace_id": trace_id,
                    "step_index": int(step_index),
                    "profile_id": "",
                    "pyroscope_url": "",
                    "sample_rate": self.sample_rate,
                    "is_active": False,
                    "sampled": False,
                    "link_path": (
                        f"{PYROSCOPE_LINK_PREFIX}/{org_id}/"
                        f"{trace_id}/{int(step_index)}"
                    ),
                    "persisted": False,
                    "created_at": _now_iso(),
                },
            )
        return _ok_envelope(
            self.name,
            {
                "trace_id": str(row.get("trace_id") or trace_id),
                "step_index": int(row.get("step_index") or step_index),
                "profile_id": str(row.get("profile_id") or ""),
                "pyroscope_url": str(row.get("pyroscope_url") or ""),
                "sample_rate": float(row.get("sample_rate") or self.sample_rate),
                "is_active": bool(row.get("is_active")),
                "sampled": True,
                "link_path": (
                    f"{PYROSCOPE_LINK_PREFIX}/{org_id}/"
                    f"{str(row.get('trace_id') or trace_id)}"
                    f"/{int(row.get('step_index') or step_index)}"
                ),
                "persisted": True,
                "created_at": str(
                    row.get("created_at") or _now_iso()
                ),
            },
        )

    async def list_trace_links(
        self,
        org_id: str,
        *,
        trace_id: str,
    ) -> dict[str, Any]:
        """List every persisted profile link for a trace.

        Returns the live ``ok`` envelope with
        ``data: {"trace_id": ..., "links": [
        {step_index, profile_id, pyroscope_url, is_active,
        sample_rate, created_at}]}``.
        """
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception:
            return _ok_envelope(
                self.name,
                {"trace_id": trace_id, "links": []},
            )
        try:
            client = await get_postgres_client()
        except Exception:
            client = None
        if client is None:
            return _ok_envelope(
                self.name,
                {"trace_id": trace_id, "links": []},
            )
        try:
            rows = await client.fetch(
                """
                SELECT step_index, profile_id, pyroscope_url,
                       sample_rate, is_active, created_at
                FROM trace_step_profile_links
                WHERE org_id = $1 AND trace_id = $2
                ORDER BY step_index ASC
                """,
                org_id, trace_id,
            )
        except Exception as exc:
            logger.debug("trace_step_profile_links list failed: %s", exc)
            rows = []
        links: list[dict[str, Any]] = []
        for r in rows or []:
            d = r if isinstance(r, dict) else dict(r)
            links.append(
                {
                    "step_index": int(d.get("step_index") or 0),
                    "profile_id": str(d.get("profile_id") or ""),
                    "pyroscope_url": str(d.get("pyroscope_url") or ""),
                    "sample_rate": float(d.get("sample_rate") or self.sample_rate),
                    "is_active": bool(d.get("is_active")),
                    "created_at": str(d.get("created_at") or ""),
                }
            )
        return _ok_envelope(
            self.name,
            {"trace_id": trace_id, "links": links},
        )
