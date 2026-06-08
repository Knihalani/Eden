"""Unit tests for the NullSandboxRunner.

Covers: execute_code, run_tests, base64 decoding, resource limits,
        probe injection, and structured JSON output parsing.
"""

import json
from unittest.mock import patch

import pytest

from eden.sandbox.runner import NullSandboxRunner, TestResult


class TestNullSandboxRunnerExecuteCode:
    @pytest.fixture
    def runner(self):
        return NullSandboxRunner()

    @pytest.mark.asyncio
    async def test_execute_simple_expression(self, runner):
        """Executing a simple Python expression returns success output."""
        result = await runner.execute_code("x = 2 + 2\nprint(x)", input_data={})
        assert result["success"] is True
        assert "4" in result.get("output", "")

    @pytest.mark.asyncio
    async def test_execute_with_error(self, runner):
        """Code that raises an exception returns error."""
        result = await runner.execute_code("raise ValueError('boom')", input_data={})
        assert result["success"] is False
        assert "boom" in result.get("error", "")

    @pytest.mark.asyncio
    async def test_execute_with_syntax_error(self, runner):
        """Syntax errors are captured in error output."""
        result = await runner.execute_code("def foo(\n", input_data={})
        assert result["success"] is False
        assert "SyntaxError" in result.get("error", "")

    @pytest.mark.asyncio
    async def test_resource_limits_applied(self, runner):
        """Resource limits are passed via preexec_fn."""
        with patch.object(runner, "_enforce_resource_limits") as mock_limits:
            mock_limits.return_value = None
            result = await runner.execute_code("print('hello')", input_data={})
            assert result["success"] is True

    @pytest.mark.asyncio
    async def test_execute_returns_dict(self, runner):
        """execute_code returns a dict with success and output/error keys."""
        result = await runner.execute_code("pass", input_data={})
        assert isinstance(result, dict)
        assert "success" in result


class TestNullSandboxRunnerRunTests:
    @pytest.fixture
    def runner(self):
        return NullSandboxRunner()

    @pytest.mark.asyncio
    async def test_run_simple_test_suite(self, runner):
        """A passing test suite returns all tests passed."""
        env_code = "x = 1\ny = 2"
        test_suite = """
assert x == 1
assert y == 2
print("All tests passed")
"""
        result = await runner.run_tests(
            code=env_code,
            test_suite=test_suite,
            exploit_probes=[],
            timeout=30,
        )
        assert isinstance(result, TestResult)
        assert result.test_count > 0
        assert result.passed > 0

    @pytest.mark.asyncio
    async def test_run_tests_with_failing_assertion(self, runner):
        """A failing assertion is counted as a failure."""
        env_code = "x = 1"
        test_suite = "assert x == 999"
        result = await runner.run_tests(
            code=env_code,
            test_suite=test_suite,
            exploit_probes=[],
            timeout=30,
        )
        assert result.failed > 0 or result.errors > 0

    @pytest.mark.asyncio
    async def test_run_tests_with_syntax_error_in_test(self, runner):
        """Syntax errors in the test suite are caught gracefully."""
        env_code = "x = 1"
        test_suite = "def bad_syntax(\n"
        result = await runner.run_tests(
            code=env_code,
            test_suite=test_suite,
            exploit_probes=[],
            timeout=30,
        )
        assert result.errors > 0

    @pytest.mark.asyncio
    async def test_run_tests_timeout(self, runner):
        """Infinite loops are killed by timeout."""
        env_code = "x = 1"
        test_suite = "while True: pass"
        result = await runner.run_tests(
            code=env_code,
            test_suite=test_suite,
            exploit_probes=[],
            timeout=2,
        )
        # Should have timed out or errored
        assert result.errors > 0 or result.failed > 0

    @pytest.mark.asyncio
    async def test_run_tests_with_probes(self, runner):
        """Exploit probes are injected and executed."""
        env_code = """
class FakeEnv:
    def __init__(self):
        self.step_count = 0
    def reset(self):
        self.step_count = 0
        return 0
    def step(self, action):
        self.step_count += 1
        return 0, 1.0, self.step_count > 5, {}
"""
        test_suite = "env = FakeEnv()\nobs = env.reset()"
        probes = [
            {
                "name": "specification_gaming",
                "category": "reward_hacking",
                "probe_code": "_probe_result = {'exploited': False}",
            }
        ]
        result = await runner.run_tests(
            code=env_code,
            test_suite=test_suite,
            exploit_probes=probes,
            timeout=30,
        )
        assert isinstance(result.exploit_findings, list)

    @pytest.mark.asyncio
    async def test_base64_encoding_avoids_escaping(self, runner):
        """Base64 encoding prevents triple-quote escaping issues."""
        env_code = 'print("""hello"""'
        test_suite = "print('safe')"
        # Should not raise due to quote escaping
        result = await runner.run_tests(
            code=env_code,
            test_suite=test_suite,
            exploit_probes=[],
            timeout=30,
        )
        assert result.test_count >= 0

    @pytest.mark.asyncio
    async def test_empty_env_code(self, runner):
        """Empty env code does not crash the runner."""
        result = await runner.run_tests(
            code="",
            test_suite="print('no env')",
            exploit_probes=[],
            timeout=30,
        )
        assert result.test_count >= 0

    @pytest.mark.asyncio
    async def test_json_markers_parsed(self, runner):
        """Structured JSON output between markers is parsed correctly."""
        env_code = ""
        test_suite = """
import json
result = {"test_count": 3, "passed": 2, "failed": 1, "errors": 0}
print("__EDEN_RESULT_START__")
print(json.dumps(result))
print("__EDEN_RESULT_END__")
"""
        result = await runner.run_tests(
            code=env_code,
            test_suite=test_suite,
            exploit_probes=[],
            timeout=30,
        )
        assert result.test_count == 3
        assert result.passed == 2
        assert result.failed == 1

    @pytest.mark.asyncio
    async def test_probe_result_variable_injected(self, runner):
        """Probe code that sets _probe_result is captured correctly."""
        env_code = ""
        test_suite = "pass"
        probes = [
            {
                "name": "reward_tampering",
                "category": "reward_hacking",
                "probe_code": "_probe_result = {'exploited': True, 'severity': 'high'}",
            }
        ]
        result = await runner.run_tests(
            code=env_code,
            test_suite=test_suite,
            exploit_probes=probes,
            timeout=30,
        )
        findings = result.exploit_findings
        assert len(findings) > 0
        assert findings[0]["probe_name"] == "reward_tampering"
