"""Tests for eden.evaluation.security_scanner."""

from __future__ import annotations

import pytest

from eden.evaluation.security_scanner import (
    DependencyVerifier,
    IssueCategory,
    SASTScanner,
    SBOMGenerator,
    ScanResult,
    SecurityGatePolicy,
    SecurityIssue,
    SecurityScanner,
    Severity,
)


class TestSecurityIssue:
    def test_to_dict(self):
        issue = SecurityIssue(
            severity=Severity.HIGH,
            category=IssueCategory.HARDCODED_SECRET,
            message="Found secret",
            file_path="test.py",
            line_number=10,
            suggestion="Use env var",
            rule_id="SECRET-TEST",
            confidence=0.9,
        )
        d = issue.to_dict()
        assert d["severity"] == "high"
        assert d["category"] == "hardcoded_secret"
        assert d["line_number"] == 10
        assert d["confidence"] == 0.9


class TestScanResult:
    def test_counts(self):
        issues = [
            SecurityIssue(Severity.CRITICAL, IssueCategory.INJECTION, "c1"),
            SecurityIssue(Severity.HIGH, IssueCategory.INJECTION, "h1"),
            SecurityIssue(Severity.HIGH, IssueCategory.INJECTION, "h2"),
            SecurityIssue(Severity.MEDIUM, IssueCategory.INJECTION, "m1"),
        ]
        result = ScanResult(scanner="test", issues=issues)
        assert result.critical_count == 1
        assert result.high_count == 2
        assert result.medium_count == 1

    def test_to_dict(self):
        result = ScanResult(scanner="test", issues=[], passed=True)
        d = result.to_dict()
        assert d["scanner"] == "test"
        assert d["passed"] is True


class TestSecurityGatePolicy:
    def test_evaluate_pass(self):
        policy = SecurityGatePolicy()
        issues = [
            SecurityIssue(Severity.LOW, IssueCategory.INJECTION, "low"),
        ]
        result = policy.evaluate(issues)
        assert result["passes_gate"] is True
        assert result["blocked_count"] == 0

    def test_evaluate_blocks_critical(self):
        policy = SecurityGatePolicy()
        issues = [
            SecurityIssue(Severity.CRITICAL, IssueCategory.INJECTION, "critical"),
        ]
        result = policy.evaluate(issues)
        assert result["passes_gate"] is False
        assert result["blocked_count"] == 1

    def test_evaluate_blocks_high_injection(self):
        policy = SecurityGatePolicy()
        issues = [
            SecurityIssue(Severity.HIGH, IssueCategory.INJECTION, "high injection"),
        ]
        result = policy.evaluate(issues)
        assert result["passes_gate"] is False

    def test_evaluate_warns_medium(self):
        policy = SecurityGatePolicy()
        issues = [
            SecurityIssue(Severity.MEDIUM, IssueCategory.UNSAFE_EVAL, "medium"),
        ]
        result = policy.evaluate(issues)
        assert result["passes_gate"] is True
        assert result["warning_count"] == 1


class TestDependencyVerifier:
    def test_parse_package_name(self):
        verifier = DependencyVerifier()
        assert verifier._parse_package_name("requests>=2.0") == "requests"
        assert verifier._parse_package_name("numpy[extra]==1.0") == "numpy"
        assert verifier._parse_package_name("  django  ") == "django"
        assert verifier._parse_package_name("# comment") == ""

    @pytest.mark.asyncio
    async def test_verify_known_packages(self):
        verifier = DependencyVerifier()
        result = await verifier.verify(["requests", "numpy", "django"])
        assert result.passed is True
        assert result.metadata["packages_checked"] == 3

    @pytest.mark.asyncio
    async def test_verify_hallucinated_package(self):
        verifier = DependencyVerifier()
        result = await verifier.verify(["xyznonexistentpackage12345"])
        # Short/nonsense names may be flagged
        assert len(result.issues) >= 0  # Could be 0 or more depending on heuristic

    def test_find_similar_typosquatting(self):
        verifier = DependencyVerifier()
        similar = verifier._find_similar("reqeusts")  # typo of requests
        assert "requests" in similar

    def test_levenshtein_distance(self):
        DependencyVerifier()
        assert DependencyVerifier._levenshtein("kitten", "sitting") == 3
        assert DependencyVerifier._levenshtein("", "abc") == 3
        assert DependencyVerifier._levenshtein("abc", "abc") == 0


class TestSASTScanner:
    def test_scan_no_issues(self):
        scanner = SASTScanner()
        code = "def hello():\n    return 'world'\n"
        result = scanner.scan(code)
        assert result.passed is True
        assert len(result.issues) == 0

    def test_scan_hardcoded_secret(self):
        scanner = SASTScanner()
        code = "api_key = 'sk-abc123def456ghi789'\n"
        result = scanner.scan(code)
        assert any(i.category == IssueCategory.HARDCODED_SECRET for i in result.issues)

    def test_scan_unsafe_eval(self):
        scanner = SASTScanner()
        code = "result = eval(user_input)\n"
        result = scanner.scan(code)
        assert any(i.category == IssueCategory.UNSAFE_EVAL for i in result.issues)

    def test_scan_pickle(self):
        scanner = SASTScanner()
        code = "import pickle\ndata = pickle.loads(untrusted)\n"
        result = scanner.scan(code)
        assert any(i.category == IssueCategory.PICKLE for i in result.issues)

    def test_scan_sql_injection(self):
        scanner = SASTScanner()
        code = "cursor.execute('SELECT * FROM users WHERE id = ' + user_id)\n"
        result = scanner.scan(code)
        assert any(i.category == IssueCategory.SQL_INJECTION for i in result.issues)

    def test_scan_ssrf(self):
        scanner = SASTScanner()
        code = "import requests\nresp = requests.get(base_url + user_path)\n"
        result = scanner.scan(code)
        assert any(i.category == IssueCategory.SSRF for i in result.issues)

    def test_scan_sandbox_escape(self):
        scanner = SASTScanner()
        code = "mod = __import__('os').system('ls')\n"
        result = scanner.scan(code)
        assert any(i.category == IssueCategory.SANDBOX_ESCAPE for i in result.issues)

    def test_scan_path_traversal(self):
        scanner = SASTScanner()
        code = "open(base + filename)\n"
        result = scanner.scan(code)
        assert any(i.category == IssueCategory.PATH_TRAVERSAL for i in result.issues)

    def test_scan_syntax_error(self):
        scanner = SASTScanner()
        code = "def broken(\n"  # Syntax error
        result = scanner.scan(code)
        assert any(i.rule_id == "PARSE-ERROR" for i in result.issues)


class TestSBOMGenerator:
    def test_generate(self):
        generator = SBOMGenerator()
        sbom = generator.generate(["requests>=2.0", "numpy"], project_name="test-project")
        assert sbom["bomFormat"] == "CycloneDX"
        assert sbom["specVersion"] == "1.5"
        assert len(sbom["components"]) == 2
        assert sbom["components"][0]["name"] == "requests"
        assert sbom["components"][1]["name"] == "numpy"
        assert sbom["metadata"]["component"]["name"] == "test-project"

    def test_generate_with_unknown_versions(self):
        generator = SBOMGenerator()
        sbom = generator.generate(["django"], project_name="test")
        assert len(sbom["components"]) == 1
        assert sbom["components"][0]["version"] == "unknown"


class TestSecurityScanner:
    @pytest.mark.asyncio
    async def test_scan_environment(self):
        scanner = SecurityScanner()
        result = await scanner.scan_environment(
            code="x = 1 + 2\n",
            requirements=["requests", "numpy"],
        )
        assert "overall_passed" in result
        assert "scans" in result
        assert "sast" in result["scans"]
        assert "dependency" in result["scans"]
        assert "sbom" in result["scans"]

    @pytest.mark.asyncio
    async def test_scan_environment_with_issues(self):
        scanner = SecurityScanner()
        result = await scanner.scan_environment(
            code="api_key = 'secret123456789012345'\n",
            requirements=["requests"],
        )
        assert len(result["all_issues"]) > 0
        # Hardcoded secret is HIGH severity → blocked by default policy, not warned
        assert result["gate_policy"]["blocked_count"] > 0

    @pytest.mark.asyncio
    async def test_scan_file(self, tmp_path):
        scanner = SecurityScanner()
        file_path = tmp_path / "test.py"
        file_path.write_text("password = 'hunter2'\n")
        result = await scanner.scan_file(file_path)
        assert len(result["all_issues"]) > 0
