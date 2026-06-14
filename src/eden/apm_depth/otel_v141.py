"""Cat 22 — OTel GenAI v1.41 dual-emit (v1.4).

The existing OTel decoder in
:mod:`eden.observability.ingestion.otel` reads ``v1.36``
attributes (the production spec until May 2026). The v1.4
ship adds v1.41 attribute support *without* breaking
v1.36-only clients:

* When a v1.36-only span comes in, the decoder reads the
  v1.36 names and *also* writes the v1.41 aliases into the
  emitted ``attributes`` JSONB (so a v1.41 dashboard can find
  the data).
* When a v1.41-only span comes in, the decoder reads the
  v1.41 names and *also* writes the v1.36 aliases (so a
  v1.36 dashboard still works).
* v1.41 names without a v1.36 equivalent (``mcp.method.name``,
  ``mcp.resource.uri``, ``mcp.prompt.name`` for the MCP
  semconv) are passed through unchanged — they're the
  authoritative v1.41 names.

The v1.4 ship also adds a small ``OtelV141Enricher`` that
the :class:`TelemetryCollector` calls post-decode to stamp
the v1.41 dual-emit aliases. The legacy decoder is
untouched so v1.36-only clients keep working.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _ok_envelope, dual_emit_attributes

logger = logging.getLogger(__name__)


#: The list of v1.41 attribute prefixes the enricher
#: auto-detects. A span is "v1.41" if any of its attribute
#: keys starts with one of these prefixes.
V141_PREFIXES: tuple[str, ...] = (
    "gen_ai.agent.",
    "gen_ai.tool.",
    "gen_ai.workflow.",
    "gen_ai.client.",
    "mcp.",
)


def detect_spec(attrs: dict[str, Any]) -> str:
    """Return ``"v141"`` if the span uses v1.41 names, else ``"v136"``.

    Detection: any attribute key starting with one of
    :data:`V141_PREFIXES` flags the span as v1.41. The
    decoder then dual-emits to v1.36. A pure v1.36 span
    has none of those prefixes; the enricher then dual-
    emits the v1.36 names *up* to v1.41.
    """
    if not isinstance(attrs, dict):
        return "v136"
    for k in attrs:
        if not isinstance(k, str):
            continue
        for prefix in V141_PREFIXES:
            if k.startswith(prefix):
                return "v141"
    return "v136"


class OtelV141Enricher:
    """The v1.41 dual-emit enricher.

    The enricher is called by the :class:`TelemetryCollector`
    post-decode. It detects the spec the span was emitted in
    and writes the missing aliases into the ``attributes``
    dict so the v1.36 + v1.41 dashboards both work.

    The enricher is also exposed as a service so the portal
    can run it on already-stored spans (e.g. when the
    customer upgrades from v1.36 to v1.41 and wants the
    historical data to appear in the v1.41 dashboards).
    """

    name = "otel_v141_enricher"

    def enrich(
        self,
        org_id: str,
        *,
        attributes: dict[str, Any],
    ) -> dict[str, Any]:
        """Dual-emit a span's attributes.

        Returns ``data: {"attributes": {...}, "spec": "v136|v141",
        "added_aliases": [...]}``. ``added_aliases`` is the
        list of alias keys the enricher wrote (useful for
        the portal's "what changed" view).
        """
        if not isinstance(attributes, dict):
            return _ok_envelope(
                self.name,
                {
                    "attributes": attributes or {},
                    "spec": "v136",
                    "added_aliases": [],
                },
            )
        spec = detect_spec(attributes)
        before = set(attributes.keys())
        enriched = dual_emit_attributes(attributes, spec=spec)
        added = sorted(set(enriched.keys()) - before)
        return _ok_envelope(
            self.name,
            {
                "attributes": enriched,
                "spec": spec,
                "added_aliases": added,
            },
        )

    def enrich_batch(
        self,
        org_id: str,
        *,
        spans: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Enrich a batch of spans.

        Returns ``data: {"spans": [...], "v141_count": N,
        "v136_count": N}``.
        """
        out_spans: list[dict[str, Any]] = []
        v141 = 0
        v136 = 0
        for span in spans:
            if not isinstance(span, dict):
                out_spans.append(span)
                continue
            attrs = span.get("attributes") or {}
            spec = detect_spec(attrs)
            if spec == "v141":
                v141 += 1
            else:
                v136 += 1
            new_attrs = dual_emit_attributes(attrs, spec=spec)
            new_span = dict(span)
            new_span["attributes"] = new_attrs
            new_span["apm.spec"] = spec
            out_spans.append(new_span)
        return _ok_envelope(
            self.name,
            {
                "spans": out_spans,
                "v141_count": v141,
                "v136_count": v136,
            },
        )
