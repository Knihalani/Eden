"""Behavioural tests for Cat 22 v1.4.1 — Pyroscope profiling.

Exercises :mod:`eden.apm_depth.profiling`:

* :func:`profile_sample_decision` — deterministic per
  trace, rate clamping, 0 / 1 short-circuits
* :func:`make_profile_id` — content-derived
  ``profile_<sha256[:16]>`` id
* :func:`build_pyroscope_url` — the v0.41+ query string
* :class:`ProfilingClient` — link_step / get_link /
  list_trace_links envelopes
"""

from __future__ import annotations

import os
import re
from unittest.mock import AsyncMock, patch

# ─── profile_sample_decision ─────────────────────────────────────


class TestProfileSampleDecision:
    def test_deterministic_per_trace(self) -> None:
        from eden.apm_depth import profile_sample_decision

        a = profile_sample_decision("trace-1", sample_rate=0.5)
        b = profile_sample_decision("trace-1", sample_rate=0.5)
        assert a == b

    def test_rate_zero_never_samples(self) -> None:
        from eden.apm_depth import profile_sample_decision

        for i in range(50):
            assert profile_sample_decision(f"t-{i}", sample_rate=0.0) is False

    def test_rate_one_always_samples(self) -> None:
        from eden.apm_depth import profile_sample_decision

        for i in range(50):
            assert profile_sample_decision(f"t-{i}", sample_rate=1.0) is True

    def test_rate_clamped(self) -> None:
        from eden.apm_depth import profile_sample_decision

        # Bad inputs
        assert profile_sample_decision("t", sample_rate="bad") is False  # type: ignore[arg-type]
        assert profile_sample_decision("t", sample_rate=2.0) is True
        assert profile_sample_decision("t", sample_rate=-1.0) is False

    def test_default_rate_is_1_percent(self) -> None:
        from eden.apm_depth import (
            DEFAULT_SAMPLE_RATE,
            profile_sample_decision,
        )

        assert DEFAULT_SAMPLE_RATE == 0.01
        # At 1% over 5000 traces, we expect ~50 sampled.
        sampled = sum(
            1
            for i in range(5000)
            if profile_sample_decision(f"trace-{i}")
        )
        assert 10 < sampled < 200  # very loose; the trace space is uniform


# ─── make_profile_id ─────────────────────────────────────────────


class TestMakeProfileId:
    def test_id_is_deterministic(self) -> None:
        from eden.apm_depth import make_profile_id

        a = make_profile_id("org_t", "trace-1", 3)
        b = make_profile_id("org_t", "trace-1", 3)
        assert a == b

    def test_id_is_unique_per_step(self) -> None:
        from eden.apm_depth import make_profile_id

        s0 = make_profile_id("org_t", "trace-1", 0)
        s1 = make_profile_id("org_t", "trace-1", 1)
        assert s0 != s1

    def test_id_is_unique_per_trace(self) -> None:
        from eden.apm_depth import make_profile_id

        t1 = make_profile_id("org_t", "trace-1", 0)
        t2 = make_profile_id("org_t", "trace-2", 0)
        assert t1 != t2

    def test_id_has_correct_prefix(self) -> None:
        from eden.apm_depth import make_profile_id

        pid = make_profile_id("org_t", "trace-1", 0)
        assert pid.startswith("profile_")
        # 16 hex chars after the prefix
        assert re.match(r"^profile_[0-9a-f]{16}$", pid)


# ─── build_pyroscope_url ─────────────────────────────────────────


class TestBuildPyroscopeUrl:
    def test_url_format(self) -> None:
        from eden.apm_depth import build_pyroscope_url

        url = build_pyroscope_url(
            "http://pyroscope:4040",
            org_id="org_t",
            trace_id="trace-1",
            step_index=3,
            profile_id="profile_abc",
        )
        assert url.startswith("http://pyroscope:4040/render?")
        assert "name=eden.org_t.step3" in url
        assert "query=" in url
        assert "trace_id" in url

    def test_strips_trailing_slash(self) -> None:
        from eden.apm_depth import build_pyroscope_url

        url = build_pyroscope_url(
            "http://pyroscope:4040/",
            org_id="org_t",
            trace_id="t",
            step_index=0,
            profile_id="p",
        )
        # No triple-slash
        assert "///render" not in url
        # And the path is correctly /render
        assert "/render?" in url

    def test_adds_http_scheme_if_missing(self) -> None:
        from eden.apm_depth import build_pyroscope_url

        url = build_pyroscope_url(
            "pyroscope.local:4040",
            org_id="org_t",
            trace_id="t",
            step_index=0,
            profile_id="p",
        )
        assert url.startswith("http://pyroscope.local:4040/")


# ─── ProfilingClient.link_step ───────────────────────────────────


class TestProfilingClientLinkStep:
    async def test_returns_envelope_with_correlation_id(self) -> None:
        from eden.apm_depth import ProfilingClient

        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            client = ProfilingClient(sample_rate=1.0)
            r = await client.link_step(
                "org_t", trace_id="trace-1", step_index=2
            )
        d = r["data"]
        assert d["trace_id"] == "trace-1"
        assert d["step_index"] == 2
        assert d["profile_id"].startswith("profile_")
        assert d["sampled"] is True
        assert d["pyroscope_url"] != ""

    async def test_returns_empty_when_not_sampled(self) -> None:
        from eden.apm_depth import ProfilingClient

        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            client = ProfilingClient(sample_rate=0.0)
            r = await client.link_step(
                "org_t", trace_id="trace-1", step_index=0
            )
        d = r["data"]
        assert d["sampled"] is False
        assert d["pyroscope_url"] == ""
        assert d["profile_id"] != ""  # Still generates the id

    async def test_handles_empty_trace_id(self) -> None:
        from eden.apm_depth import ProfilingClient

        client = ProfilingClient(sample_rate=1.0)
        r = await client.link_step("org_t", trace_id="", step_index=0)
        d = r["data"]
        assert d["pyroscope_url"] == ""
        assert d["profile_id"] == ""

    async def test_get_link_no_row(self) -> None:
        from eden.apm_depth import ProfilingClient

        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            r = await ProfilingClient().get_link(
                "org_t", trace_id="trace-1", step_index=0
            )
        assert r["data"]["sampled"] is False
        assert r["data"]["pyroscope_url"] == ""

    async def test_list_trace_links_empty(self) -> None:
        from eden.apm_depth import ProfilingClient

        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            r = await ProfilingClient().list_trace_links(
                "org_t", trace_id="trace-1"
            )
        assert r["data"]["links"] == []


# ─── Pyroscope env-var override ──────────────────────────────────


class TestProfilingClientEnv:
    def test_env_var_overrides_host(self) -> None:
        from eden.apm_depth import ProfilingClient

        with patch.dict(
            os.environ, {"EDEN_PYROSCOPE_HOST": "http://custom-host:9999"}
        ):
            client = ProfilingClient()
        assert "custom-host" in client.pyroscope_host

    def test_default_is_oss_pyroscope(self) -> None:
        from eden.apm_depth import (
            DEFAULT_PYROSCOPE_HOST,
            ProfilingClient,
        )

        with patch.dict(os.environ, {}, clear=True):
            client = ProfilingClient()
        assert client.pyroscope_host == DEFAULT_PYROSCOPE_HOST
