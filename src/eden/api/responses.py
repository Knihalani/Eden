"""JSON response class backed by ``eden.util.jsonx``.

Measured on a realistic Eden list response (traces with nested spans,
datetimes, Decimals), best-of-5 medians:

| response size | jsonable_encoder | stdlib render | jsonx render | render gain |
|---|---|---|---|---|
| 1.2 KiB   |    61 us |   10.5 us |   2.4 us | 4.31x |
| 26.8 KiB  |  1363 us |  193.1 us |  50.1 us | 3.86x |
| 213.7 KiB | 10922 us | 1494.9 us | 397.9 us | 3.76x |

Two things follow, and the second is the interesting one.

**Swapping the response class is worth ~1.1x end to end, not ~4x.** FastAPI's
``serialize_response`` runs ``jsonable_encoder`` unconditionally and
``default_response_class`` only replaces ``render()``. The encoder costs roughly
seven times the render it feeds, so a 3.8x faster render moves the total by
about 10%. Worth taking — it is free and strictly correct — but anyone quoting
the render-step multiple as a global speedup is overstating it by ~4x.

**The encoder is the actual cost.** A handler that returns a Response instance
skips ``serialize_response`` entirely, and orjson serialises the raw objects
itself (datetimes natively, Decimal via ``default=str``). Measured: 499.8us
versus 12417.1us for a 213.7 KiB payload — **24.9x**. That is a per-endpoint
change rather than a global one, because returning a Response also skips
``response_model`` validation and filtering, so it needs judgement about
whether a given endpoint's schema is load-bearing. Not done wholesale here.

Wrapping ``jsonx`` rather than using ``fastapi.responses.ORJSONResponse``
matters for correctness, not just speed: ``jsonx`` sets
``orjson.OPT_NON_STR_KEYS`` and the stock class does not, so a dict keyed by
int or UUID — which Eden produces in several aggregation payloads — raises
``TypeError`` under the stock class and serialises fine here.
"""

from __future__ import annotations

from typing import Any

from starlette.responses import JSONResponse

from eden.util.jsonx import dumps_bytes


class EdenJSONResponse(JSONResponse):
    """``JSONResponse`` whose ``render`` goes through ``jsonx``."""

    def render(self, content: Any) -> bytes:
        # ``default=str`` matches jsonx's own default and the stdlib fallback
        # branch, so a type orjson cannot serialise natively degrades to its
        # string form instead of raising mid-response — by which point the
        # status line has already been sent.
        return dumps_bytes(content)


__all__ = ["EdenJSONResponse"]
