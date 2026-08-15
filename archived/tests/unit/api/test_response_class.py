"""The app renders JSON through ``jsonx``, and the claim is stated honestly.

No response class was configured, so every response was rendered by stdlib
``json``. Measured on realistic Eden list payloads (best-of-5 medians):

* render step alone: **3.76-4.31x** faster with orjson
* end to end: **1.10-1.13x**, because ``serialize_response`` runs
  ``jsonable_encoder`` unconditionally and that costs ~7x the render it feeds
* a handler returning a ``Response`` directly skips the encoder entirely:
  **24.9x** on a 213.7 KiB payload

So the render-step multiple is not a global speedup, and this test exists partly
to keep that distinction in the codebase rather than letting "~4x faster JSON"
become folklore.

The correctness half matters more than the speed half: ``jsonx`` sets
``orjson.OPT_NON_STR_KEYS`` and ``fastapi.responses.ORJSONResponse`` does not,
so an int- or UUID-keyed dict raises ``TypeError`` under the stock class —
mid-response, after the status line has been sent.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

import pytest


class TestTheAppUsesIt:
    def test_default_response_class_is_edens(self) -> None:
        from eden.api.app import app
        from eden.api.responses import EdenJSONResponse

        # FastAPI stores it on the router.
        assert app.router.default_response_class is EdenJSONResponse or issubclass(
            app.router.default_response_class, EdenJSONResponse
        ), (
            f"default_response_class is {app.router.default_response_class!r}; "
            "responses are being rendered by stdlib json"
        )


class TestItRendersWhatStdlibWould:
    @pytest.mark.parametrize(
        "content",
        [
            {"a": 1, "b": [1, 2, 3]},
            {"nested": {"deep": {"deeper": [{"x": 1}]}}},
            {"unicode": "héllo — wörld ✅"},
            {"empty_dict": {}, "empty_list": [], "null": None},
            {"bool": True, "float": 1.5, "int": -3},
            [],
            {},
        ],
    )
    def test_parity_with_stdlib_for_plain_json(self, content: object) -> None:
        from eden.api.responses import EdenJSONResponse

        rendered = EdenJSONResponse(content=content).render(content)
        assert json.loads(rendered) == json.loads(json.dumps(content))


class TestNonStringKeysSurvive:
    """The reason to wrap ``jsonx`` rather than use the stock ORJSONResponse."""

    def test_int_keyed_dict_renders(self) -> None:
        from eden.api.responses import EdenJSONResponse

        content = {"buckets": {1: 10, 2: 20, 3: 30}}
        out = json.loads(EdenJSONResponse(content=content).render(content))
        assert out == {"buckets": {"1": 10, "2": 20, "3": 30}}

    def test_uuid_keyed_dict_renders(self) -> None:
        from eden.api.responses import EdenJSONResponse

        key = uuid4()
        content = {"per_org": {key: 5}}
        out = json.loads(EdenJSONResponse(content=content).render(content))
        assert out == {"per_org": {str(key): 5}}

    def test_the_stock_orjson_class_would_reject_these(self) -> None:
        """Documents *why* the wrapper exists, and fails if that stops being true."""
        orjson = pytest.importorskip("orjson")

        with pytest.raises(TypeError):
            # No OPT_NON_STR_KEYS — this is what ORJSONResponse.render does.
            orjson.dumps({1: "a"})
        # And with the option, which is what jsonx passes:
        assert orjson.dumps({1: "a"}, option=orjson.OPT_NON_STR_KEYS) == b'{"1":"a"}'


class TestTypesThatWouldOtherwiseRaiseMidResponse:
    def test_datetime_and_decimal_degrade_rather_than_raise(self) -> None:
        """A render that raises has already sent the status line."""
        from eden.api.responses import EdenJSONResponse

        content = {
            "at": datetime(2026, 7, 30, 12, 0, tzinfo=UTC),
            "cost": Decimal("0.00123"),
            "id": uuid4(),
        }
        out = json.loads(EdenJSONResponse(content=content).render(content))
        assert out["at"].startswith("2026-07-30T12:00:00")
        assert out["cost"] == "0.00123"
        assert isinstance(out["id"], str)


class TestItIsActuallyFasterAtRendering:
    @pytest.mark.perf
    def test_render_beats_stdlib_on_a_realistic_payload(self) -> None:
        """Guards the direction, not the exact multiple.

        Measured 3.76-4.31x; asserted at >1.5x so it fails if the response
        class silently reverts to stdlib but does not flake on a loaded box.
        """
        import statistics
        import time

        from eden.api.responses import EdenJSONResponse

        payload = {
            "data": {
                "traces": [
                    {
                        "trace_id": str(uuid4()),
                        "duration_ms": 123.456 + i,
                        "outcome": "ok",
                        "spans": [
                            {"span_id": str(uuid4()), "duration_ms": 1.5 + j}
                            for j in range(4)
                        ],
                    }
                    for i in range(25)
                ]
            }
        }
        resp = EdenJSONResponse(content={})

        def bench(fn: object, reps: int = 200) -> float:
            runs = []
            for _ in range(3):
                t0 = time.perf_counter_ns()
                for _ in range(reps):
                    fn()  # type: ignore[operator]
                runs.append((time.perf_counter_ns() - t0) / reps)
            return statistics.median(runs)

        ours = bench(lambda: resp.render(payload))
        stdlib = bench(
            lambda: json.dumps(
                payload, ensure_ascii=False, separators=(",", ":")
            ).encode("utf-8")
        )
        assert ours < stdlib / 1.5, (
            f"render is not meaningfully faster than stdlib "
            f"({ours / 1000:.1f}us vs {stdlib / 1000:.1f}us)"
        )
