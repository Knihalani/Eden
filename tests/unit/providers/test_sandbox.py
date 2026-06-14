"""Unit tests for :class:`eden.providers.sandbox`.

Covers: success path, exit code capture, timeout, missing
binary, the rlimit preexec_fn shape, the NullSandboxProvider
counter, and the default-provider factory.
"""

from __future__ import annotations

import asyncio
import os
import sys
from unittest.mock import patch

import pytest


class TestLocalSandboxProvider:
    @pytest.fixture
    def provider(self):
        from eden.providers.sandbox import LocalSandboxProvider
        return LocalSandboxProvider()

    @pytest.mark.asyncio
    async def test_run_simple_command_succeeds(self, provider):
        from eden.providers.sandbox import SandboxSpec
        result = await provider.run(SandboxSpec(
            image="local",
            command=[sys.executable, "-c", "print(2 + 2)"],
            timeout_sec=10,
        ))
        assert result.success is True
        assert result.exit_code == 0
        assert "4" in result.stdout
        assert result.provider == "local"
        assert result.duration_ms >= 0

    @pytest.mark.asyncio
    async def test_run_captures_nonzero_exit_code(self, provider):
        from eden.providers.sandbox import SandboxSpec
        result = await provider.run(SandboxSpec(
            image="local",
            command=[sys.executable, "-c",
                     "import sys; sys.exit(7)"],
            timeout_sec=10,
        ))
        assert result.success is False
        assert result.exit_code == 7

    @pytest.mark.asyncio
    async def test_run_captures_stderr(self, provider):
        from eden.providers.sandbox import SandboxSpec
        result = await provider.run(SandboxSpec(
            image="local",
            command=[sys.executable, "-c",
                     "import sys; print('boom', file=sys.stderr)"],
            timeout_sec=10,
        ))
        assert "boom" in result.stderr

    @pytest.mark.asyncio
    async def test_run_with_empty_command(self, provider):
        from eden.providers.sandbox import SandboxSpec
        result = await provider.run(SandboxSpec(
            image="local",
            command=[],
            timeout_sec=10,
        ))
        assert result.success is False
        assert "empty" in result.stderr.lower()

    @pytest.mark.asyncio
    async def test_run_with_missing_binary(self, provider):
        from eden.providers.sandbox import SandboxSpec
        result = await provider.run(SandboxSpec(
            image="local",
            command=["__definitely_not_a_real_binary_999__"],
            timeout_sec=10,
        ))
        assert result.success is False
        # FileNotFoundError surfaces as exit_code=-1 + a
        # descriptive stderr.
        assert result.exit_code == -1
        assert "not found" in result.stderr.lower()

    @pytest.mark.asyncio
    async def test_run_with_timeout(self, provider):
        from eden.providers.sandbox import SandboxSpec
        # Sleep for 10s, but the timeout is 1s. The
        # provider kills the subprocess and returns a
        # timed-out result.
        result = await provider.run(SandboxSpec(
            image="local",
            command=[sys.executable, "-c",
                     "import time; time.sleep(10)"],
            timeout_sec=1,
        ))
        assert result.success is False
        assert result.timed_out is True

    @pytest.mark.asyncio
    async def test_run_with_invalid_workdir(self, provider):
        from eden.providers.sandbox import SandboxSpec
        result = await provider.run(SandboxSpec(
            image="local",
            command=[sys.executable, "-c", "pass"],
            workdir="/__nonexistent_path_999__",
            timeout_sec=5,
        ))
        assert result.success is False
        assert "workdir" in result.stderr.lower()

    @pytest.mark.asyncio
    async def test_run_passes_env(self, provider):
        from eden.providers.sandbox import SandboxSpec
        result = await provider.run(SandboxSpec(
            image="local",
            command=[sys.executable, "-c",
                     "import os; print(os.environ.get('EDEN_TEST_KEY', 'missing'))"],
            env={"EDEN_TEST_KEY": "hello-eden"},
            timeout_sec=10,
        ))
        assert "hello-eden" in result.stdout

    def test_preexec_fn_is_none_when_no_limits(self, provider):
        fn = provider._build_preexec_fn(cpu_limit=None, memory_mb=None)
        assert fn is None

    def test_preexec_fn_is_callable_when_cpu_limit_set(self, provider):
        fn = provider._build_preexec_fn(cpu_limit=5.0, memory_mb=None)
        assert fn is not None
        assert callable(fn)

    def test_preexec_fn_is_callable_when_memory_limit_set(self, provider):
        fn = provider._build_preexec_fn(cpu_limit=None, memory_mb=256)
        assert fn is not None

    def test_provider_name(self, provider):
        assert provider.name == "local"


class TestNullSandboxProvider:
    @pytest.fixture
    def provider(self):
        from eden.providers.sandbox import NullSandboxProvider
        return NullSandboxProvider()

    @pytest.mark.asyncio
    async def test_run_returns_success(self, provider):
        from eden.providers.sandbox import SandboxSpec
        result = await provider.run(SandboxSpec(
            image="n/a", command=["anything"], timeout_sec=10,
        ))
        assert result.success is True
        assert result.exit_code == 0
        assert result.provider == "null"

    @pytest.mark.asyncio
    async def test_increments_call_count(self, provider):
        from eden.providers.sandbox import SandboxSpec
        assert provider.call_count == 0
        await provider.run(SandboxSpec(image="n/a", command=["x"]))
        await provider.run(SandboxSpec(image="n/a", command=["y"]))
        assert provider.call_count == 2

    def test_provider_name(self, provider):
        assert provider.name == "null"


class TestGetDefaultSandboxProvider:
    def test_default_is_local(self, monkeypatch):
        monkeypatch.delenv("EDEN_SANDBOX_PROVIDER", raising=False)
        from eden.providers.sandbox import (
            LocalSandboxProvider,
            get_default_sandbox_provider,
        )
        assert isinstance(get_default_sandbox_provider(), LocalSandboxProvider)

    def test_null_when_env_set(self, monkeypatch):
        monkeypatch.setenv("EDEN_SANDBOX_PROVIDER", "null")
        from eden.providers.sandbox import (
            NullSandboxProvider,
            get_default_sandbox_provider,
        )
        assert isinstance(get_default_sandbox_provider(), NullSandboxProvider)
