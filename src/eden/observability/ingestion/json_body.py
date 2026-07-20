"""Hot-path JSON decode for ingest decoders (orjson via jsonx).

All format detectors/decoders should use :func:`loads_body` instead of
``json.loads`` so large OTLP / batch payloads avoid stdlib JSON overhead.
"""

from __future__ import annotations

from typing import Any

from eden.util.jsonx import loads as loads_body

__all__ = ["loads_body"]
