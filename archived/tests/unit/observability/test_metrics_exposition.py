"""``/metrics`` must emit a *parseable* Prometheus exposition.

Three separate defects made the endpoint's output invalid, each of which a
scraper reports as one opaque failure rather than as a missing metric:

1. ``eden_llm_provider_errors_total`` rendered a Python dict repr where a
   float belongs, because the per-provider counts are a nested mapping and the
   value was passed straight through.
2. ``# HELP``/``# TYPE`` were emitted once per *sample* rather than once per
   *family*, because the renderer was called inside a loop.
   ``expfmt.TextParser`` — what Pushgateway and ``promtool check metrics`` use
   — aborts the whole scrape with *"second HELP line for metric name"*.
3. The request-latency histogram dropped its ``method`` and ``route`` labels,
   so every route collapsed onto one series. With N routes the identical
   bucket line was emitted N times and only one survived; p95/p99 described a
   single arbitrary route while appearing to describe the service.

The tests below are the standing guard for all three. They deliberately drive
the endpoint with *several* samples in each multi-sample family, because with
zero or one sample none of these bugs is observable.
"""

from __future__ import annotations

import collections
import re

import pytest

_HELP_RE = re.compile(r"^# HELP (\S+)", re.M)
_TYPE_RE = re.compile(r"^# TYPE (\S+) (\S+)", re.M)
_SAMPLE_RE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^}]*\})?) (.+)$", re.M)


@pytest.fixture(autouse=True)
def _reset() -> None:
    from eden.api.middleware.latency import reset_metrics_snapshot
    from eden.observability.drop_metrics import reset_for_tests as reset_drops
    from eden.observability.simple_metrics import reset_for_tests as reset_simple

    reset_metrics_snapshot()
    reset_drops()
    reset_simple()
    yield
    reset_metrics_snapshot()
    reset_drops()
    reset_simple()


@pytest.fixture
def populated(monkeypatch: pytest.MonkeyPatch) -> None:
    """Put >1 sample into every family that renders a loop."""
    import eden.llm.client as llm_client
    from eden.api.middleware.latency import _histogram
    from eden.observability.drop_metrics import record_drop

    # Two routes and two methods — the case that used to collide.
    _histogram.observe("GET", "/v1/traces", 200, 12.0)
    _histogram.observe("GET", "/v1/traces", 200, 300.0)
    _histogram.observe("POST", "/v1/ingest", 202, 7.0)

    monkeypatch.setattr(
        llm_client,
        "get_provider_error_counts",
        lambda: {
            "openai": {"calls": 10, "errors": 2, "error_rate": 0.2},
            "anthropic": {"calls": 5, "errors": 0, "error_rate": 0.0},
        },
    )

    record_drop("ingest", "load_shed", 5)
    record_drop("sink_ch", "write_error")


async def _body() -> str:
    from eden.observability.metrics_endpoint import metrics

    resp = await metrics()
    return resp.body.decode("utf-8")


class TestExpositionIsValid:
    @pytest.mark.asyncio
    async def test_no_duplicate_help_lines(self, populated: None) -> None:
        text = await _body()
        dupes = {n: c for n, c in collections.Counter(_HELP_RE.findall(text)).items() if c > 1}
        assert not dupes, (
            f"families with more than one # HELP line: {dupes}. expfmt-based "
            "consumers reject the entire scrape on the second HELP line — "
            "render each family once via _render_family()."
        )

    @pytest.mark.asyncio
    async def test_no_duplicate_type_lines(self, populated: None) -> None:
        text = await _body()
        names = [n for n, _ in _TYPE_RE.findall(text)]
        dupes = {n: c for n, c in collections.Counter(names).items() if c > 1}
        assert not dupes, f"families with more than one # TYPE line: {dupes}"

    @pytest.mark.asyncio
    async def test_no_duplicate_series(self, populated: None) -> None:
        """Two samples sharing a name *and* label set silently lose one value."""
        text = await _body()
        series = [m.group(1) for m in _SAMPLE_RE.finditer(text)]
        dupes = {s: c for s, c in collections.Counter(series).items() if c > 1}
        assert not dupes, (
            f"identical series emitted more than once: {dupes}. One of each "
            "pair is discarded at parse time — add the distinguishing label."
        )

    @pytest.mark.asyncio
    async def test_every_sample_value_is_numeric(self, populated: None) -> None:
        """Guards the dict-repr-as-a-value bug."""
        text = await _body()
        bad: list[str] = []
        for m in _SAMPLE_RE.finditer(text):
            raw = m.group(2).strip()
            try:
                float(raw)
            except ValueError:
                bad.append(f"{m.group(1)} -> {raw!r}")
        assert not bad, f"non-numeric sample values: {bad}"

    @pytest.mark.asyncio
    async def test_every_sample_belongs_to_a_declared_family(self, populated: None) -> None:
        """A sample with no HELP/TYPE is untyped and loses its metadata."""
        text = await _body()
        declared = set(_HELP_RE.findall(text))
        orphans = set()
        for m in _SAMPLE_RE.finditer(text):
            base = m.group(1).split("{")[0]
            for suffix in ("_bucket", "_sum", "_count"):
                if base.endswith(suffix):
                    base = base[: -len(suffix)]
                    break
            if base not in declared:
                orphans.add(base)
        assert not orphans, f"samples with no declared family: {sorted(orphans)}"

    @pytest.mark.asyncio
    async def test_body_parses_with_the_prometheus_client_parser(
        self, populated: None
    ) -> None:
        parser = pytest.importorskip("prometheus_client.parser")
        text = await _body()
        families = list(parser.text_string_to_metric_families(text))
        assert families, "parser produced no families"


class TestLatencyHistogramLabels:
    @pytest.mark.asyncio
    async def test_route_and_method_labels_are_present(self, populated: None) -> None:
        text = await _body()
        assert 'route="/v1/traces"' in text
        assert 'route="/v1/ingest"' in text
        assert 'method="GET"' in text
        assert 'method="POST"' in text

    @pytest.mark.asyncio
    async def test_each_route_keeps_its_own_counts(self, populated: None) -> None:
        """Two routes must produce two distinct _count series, not one."""
        text = await _body()
        counts = dict(
            re.findall(
                r'eden_request_duration_ms_count\{([^}]*)\} (\S+)',
                text,
            )
        )
        assert len(counts) == 2, f"expected one _count per route, got {counts}"
        by_route = {
            re.search(r'route="([^"]+)"', k).group(1): float(v)
            for k, v in counts.items()
        }
        assert by_route["/v1/traces"] == 2.0
        assert by_route["/v1/ingest"] == 1.0

    @pytest.mark.asyncio
    async def test_buckets_are_cumulative(self, populated: None) -> None:
        """histogram_quantile is meaningless unless buckets are cumulative."""
        text = await _body()
        rows = re.findall(
            r'eden_request_duration_ms_bucket\{le="([^"]+)",method="GET",route="/v1/traces"\} (\S+)',
            text,
        )
        assert rows, "no bucket samples for the GET /v1/traces series"
        finite = [(float(le), float(v)) for le, v in rows if le != "+Inf"]
        values = [v for _, v in sorted(finite)]
        assert values == sorted(values), f"buckets are not monotonic: {values}"
        inf = [float(v) for le, v in rows if le == "+Inf"]
        assert inf and inf[0] >= values[-1]


class TestProviderCounters:
    @pytest.mark.asyncio
    async def test_errors_and_calls_are_separate_numeric_counters(
        self, populated: None
    ) -> None:
        text = await _body()
        assert 'eden_llm_provider_errors_total{provider="openai"} 2.0' in text
        assert 'eden_llm_provider_calls_total{provider="openai"} 10.0' in text
        assert 'eden_llm_provider_errors_total{provider="anthropic"} 0.0' in text


class TestDroppedEventsFamily:
    @pytest.mark.asyncio
    async def test_recorded_drops_are_exposed(self, populated: None) -> None:
        text = await _body()
        assert 'eden_events_dropped_total{reason="load_shed",stage="ingest"} 5.0' in text
        assert 'eden_events_dropped_total{reason="write_error",stage="sink_ch"} 1.0' in text

    @pytest.mark.asyncio
    async def test_seeded_pairs_expose_a_zero(self, populated: None) -> None:
        """An absent series cannot be distinguished from broken instrumentation."""
        text = await _body()
        assert 'eden_events_dropped_total{reason="queue_full",stage="queue"} 0.0' in text


class TestFormerlyDarkModules:
    """Both modules recorded into a registry ``/metrics`` never read."""

    @pytest.mark.asyncio
    async def test_checkpoint_hook_metrics_are_exposed(self) -> None:
        from eden.observability.ingestion.checkpoint_hook import _Metrics

        _Metrics.get().total.labels(status="ok").inc()
        _Metrics.get().duration.observe(0.25)
        text = await _body()
        assert 'eden_checkpoint_ingest_total{status="ok"} 1.0' in text
        assert "eden_checkpoint_ingest_duration_seconds_sum 0.25" in text
        assert "eden_checkpoint_ingest_duration_seconds_count 1.0" in text

    @pytest.mark.asyncio
    async def test_quality_worker_metrics_are_exposed(self) -> None:
        from eden.observability.quality_pipeline.worker import _Metrics

        _Metrics.get().traces_total.labels(status="dlq").inc()
        _Metrics.get().step_duration.labels(step="tas").observe(1.5)
        _Metrics.get().watermark_age.set(42)
        text = await _body()
        assert 'quality_pipeline_traces_total{status="dlq"} 1.0' in text
        assert 'quality_pipeline_step_duration_seconds_sum{step="tas"} 1.5' in text
        assert "quality_pipeline_watermark_age_seconds 42.0" in text

    def test_no_module_registers_into_the_prometheus_default_registry(self) -> None:
        """The regression that made both modules dark in the first place."""
        import os
        import subprocess
        import sys

        src = (
            "import eden.observability.ingestion.checkpoint_hook\n"
            "import eden.observability.quality_pipeline.worker\n"
            "import sys\n"
            "print('prometheus_client' in sys.modules)\n"
        )
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)}
        out = subprocess.run(
            [sys.executable, "-c", src], capture_output=True, text=True, env=env
        )
        assert out.stdout.strip() == "False", (
            "importing the metric modules pulled in prometheus_client; their "
            "counters would register into its default registry, which the "
            f"hand-rolled /metrics endpoint never reads. stderr={out.stderr}"
        )
