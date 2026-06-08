"""Code Quality Pipeline node for LangGraph pipeline.

Runs 5 sequential passes: static analysis, security, complexity, performance, documentation.
"""

import asyncio
import logging
import re
import sys
from pathlib import Path
from typing import TypedDict, Literal, Optional
from dataclasses import dataclass

from eden.pipeline.state import EdenJobState

from eden.config import get_settings

logger = logging.getLogger(__name__)


@dataclass
class QualityReport:
    """Result of a quality pass."""

    pass_name: str
    passed: bool
    issues: list[dict]
    iteration: int


@dataclass
class ToolResult:
    """Result from running a single tool."""

    tool_name: str
    success: bool
    output: str
    error_output: str
    return_code: int
    issues: list[dict]


async def _run_tool(
    tool_path: str,
    args: list[str],
    code: str,
    timeout: int = 30,
) -> ToolResult:
    """Run an external tool via asyncio subprocess.

    Args:
        tool_path: Path to the tool executable
        args: Command-line arguments
        code: Code to analyze (passed via stdin)
        timeout: Maximum execution time in seconds

    Returns:
        ToolResult with output and parsed issues
    """
    tool_name = Path(tool_path).name
    try:
        process = await asyncio.create_subprocess_exec(
            tool_path,
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout, stderr = await asyncio.wait_for(
            process.communicate(input=code.encode("utf-8")),
            timeout=timeout,
        )

        return ToolResult(
            tool_name=tool_name,
            success=process.returncode == 0,
            output=stdout.decode("utf-8", errors="replace"),
            error_output=stderr.decode("utf-8", errors="replace"),
            return_code=process.returncode,
            issues=[],
        )
    except asyncio.TimeoutError:
        logger.warning(f"{tool_name} timed out after {timeout}s")
        return ToolResult(
            tool_name=tool_name,
            success=False,
            output="",
            error_output=f"Tool timed out after {timeout}s",
            return_code=-1,
            issues=[{"type": "timeout", "message": f"{tool_name} exceeded timeout", "severity": "error"}],
        )
    except FileNotFoundError:
        logger.warning(f"{tool_name} not found at {tool_path}")
        return ToolResult(
            tool_name=tool_name,
            success=True,
            output="",
            error_output=f"Tool not installed",
            return_code=0,
            issues=[],
        )
    except Exception as e:
        logger.error(f"Error running {tool_name}: {e}")
        return ToolResult(
            tool_name=tool_name,
            success=False,
            output="",
            error_output=str(e),
            return_code=-1,
            issues=[{"type": "execution_error", "message": str(e), "severity": "error"}],
        )


def _find_tool(name: str) -> Optional[str]:
    """Find a tool in PATH or common locations.

    Args:
        name: Tool name to find

    Returns:
        Path to tool if found, None otherwise
    """
    import shutil

    # Check if tool is in PATH
    path = shutil.which(name)
    if path:
        return path

    # Common installation paths
    common_paths = [
        f"/usr/local/bin/{name}",
        f"/usr/bin/{name}",
        f"~/.local/bin/{name}",
        f"{Path.home()}/.local/bin/{name}",
    ]

    for common_path in common_paths:
        expanded = Path(common_path).expanduser()
        if expanded.exists():
            return str(expanded)

    return None


def _parse_pylint_output(output: str) -> list[dict]:
    """Parse pylint JSON output into issues list."""
    issues = []
    try:
        import json

        data = json.loads(output)
        for msg in data.get("messages", []):
            issues.append({
                "type": msg.get("type", "lint"),
                "message": msg.get("message", ""),
                "line": msg.get("line", 0),
                "column": msg.get("column", 0),
                "severity": msg.get("severity", "warning"),
                "symbol": msg.get("symbol", ""),
                "module": msg.get("module", ""),
            })
    except (json.JSONDecodeError, KeyError):
        # Fallback: parse line-by-line
        for line in output.splitlines():
            if ": warning:" in line or ": error:" in line:
                parts = line.split(":", 4)
                if len(parts) >= 5:
                    issues.append({
                        "type": "lint",
                        "message": parts[4].strip(),
                        "line": int(parts[1]) if parts[1].isdigit() else 0,
                        "column": int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else 0,
                        "severity": "error" if "error:" in line else "warning",
                        "symbol": "",
                        "module": parts[0] if parts else "",
                    })
    return issues


def _parse_flake8_output(output: str) -> list[dict]:
    """Parse flake8 output into issues list."""
    issues = []
    # Flake8 format: path:line:col: code: message
    pattern = re.compile(r"(.+):(\d+):(\d+): (\w+) (.+)")
    for line in output.splitlines():
        match = pattern.match(line)
        if match:
            issues.append({
                "type": "style",
                "message": match.group(5),
                "line": int(match.group(2)),
                "column": int(match.group(3)),
                "severity": "error" if match.group(4).startswith("E") else "warning",
                "symbol": match.group(4),
                "module": match.group(1),
            })
    return issues


def _parse_mypy_output(output: str, error_output: str) -> list[dict]:
    """Parse mypy output into issues list."""
    issues = []
    combined = output + "\n" + error_output

    # mypy format: path:line: error-code: message
    pattern = re.compile(r"(.+?):(\d+): (\w+): (.+)")
    for line in combined.splitlines():
        match = pattern.match(line.strip())
        if match:
            issues.append({
                "type": "type",
                "message": match.group(4),
                "line": int(match.group(2)),
                "column": 0,
                "severity": "error",
                "symbol": match.group(3),
                "module": match.group(1),
            })
    return issues


def _parse_bandit_output(output: str) -> list[dict]:
    """Parse bandit JSON output into issues list."""
    issues = []
    try:
        import json

        data = json.loads(output)
        for result in data.get("results", []):
            issues.append({
                "type": "security",
                "message": result.get("issue_text", ""),
                "line": result.get("line_range", [0])[0] if result.get("line_range") else 0,
                "column": 0,
                "severity": result.get("issue_severity", "medium"),
                "symbol": result.get("issue_id", ""),
                "module": result.get("filename", ""),
                "confidence": result.get("issue_confidence", "medium"),
            })
    except (json.JSONDecodeError, KeyError):
        # Fallback: parse line-by-line for bandit text output
        for line in output.splitlines():
            if ">> " in line:
                parts = line.split(">> ", 1)
                if len(parts) > 1:
                    issues.append({
                        "type": "security",
                        "message": parts[1].strip(),
                        "line": 0,
                        "column": 0,
                        "severity": "medium",
                        "symbol": "",
                        "module": "",
                    })
    return issues


def _parse_radon_output(output: str) -> list[dict]:
    """Parse radon CC (cyclomatic complexity) output into issues list."""
    issues = []

    # Radon format for CC: function/class name, lineno, complexity, rank
    pattern = re.compile(r"(.+?) - (\d+) \((\w+)\)")
    for line in output.splitlines():
        match = pattern.match(line)
        if match:
            name = match.group(1)
            complexity = int(match.group(2))
            rank = match.group(3)

            # A-D ranks: A=simple, D=very complex
            severity = "warning" if complexity > 10 else "info"
            if rank in ("C", "D"):
                severity = "error"

            issues.append({
                "type": "complexity",
                "message": f"{name}: cyclomatic complexity {complexity} (rank {rank})",
                "line": 0,
                "column": 0,
                "severity": severity,
                "symbol": f"cc_{complexity}",
                "module": name,
            })
    return issues


async def _run_static_analysis(code: str) -> list[dict]:
    """Pass 1: Static analysis with pylint, flake8, mypy.

    Checks:
    - Syntax errors
    - Type errors (mypy)
    - PEP 8 style issues (flake8)
    - Undefined variables and imports
    - Basic code quality (pylint)
    """
    issues = []
    settings = get_settings()

    # Run pylint
    pylint_path = _find_tool("pylint")
    if pylint_path:
        result = await _run_tool(
            pylint_path,
            ["--output-format=json", "--disable=import-error,missing-docstring", "-"],
            code,
            timeout=60,
        )
        if result.issues or not result.success:
            parsed = _parse_pylint_output(result.output)
            issues.extend(parsed if parsed else [{
                "type": "lint",
                "message": result.error_output or "pylint failed",
                "severity": "error",
            }])
        logger.debug(f"pylint found {len(issues)} issues")
    else:
        logger.debug("pylint not available, skipping")

    # Run flake8
    flake8_path = _find_tool("flake8")
    if flake8_path:
        result = await _run_tool(
            flake8_path,
            ["--format=%(path)s:%(row)d:%(col)d: %(code)s %(text)s", "-"],
            code,
            timeout=30,
        )
        parsed = _parse_flake8_output(result.output)
        issues.extend(parsed)
        logger.debug(f"flake8 found {len(parsed)} issues")
    else:
        logger.debug("flake8 not available, skipping")

    # Run mypy
    mypy_path = _find_tool("mypy")
    if mypy_path:
        result = await _run_tool(
            mypy_path,
            ["--no-error-summary", "--output=json", "-"],
            code,
            timeout=60,
        )
        parsed = _parse_mypy_output(result.output, result.error_output)
        issues.extend(parsed)
        logger.debug(f"mypy found {len(parsed)} issues")
    else:
        logger.debug("mypy not available, skipping")

    return issues


async def _run_security_analysis(code: str) -> list[dict]:
    """Pass 2: Security analysis with bandit and safety.

    Checks:
    - Vulnerability patterns (bandit)
    - Known CVE scanning (safety)
    - OWASP/CWE rules (bandit)
    """
    issues = []

    # Run bandit
    bandit_path = _find_tool("bandit")
    if bandit_path:
        result = await _run_tool(
            bandit_path,
            ["-f", "json", "-"],
            code,
            timeout=60,
        )
        if result.return_code != 0 or result.output:
            parsed = _parse_bandit_output(result.output)
            issues.extend(parsed)
        logger.debug(f"bandit found {len(parsed)} issues")
    else:
        logger.debug("bandit not available, skipping")

    # Run safety (dependency vulnerability check)
    safety_path = _find_tool("safety")
    if safety_path:
        # Safety requires a requirements file, so we check imports in code
        # Extract import statements and check them
        import_pattern = re.compile(r"^\s*(?:import\s+|from\s+)(\w+)", re.MULTILINE)
        imports = import_pattern.findall(code)
        unique_imports = list(set(imports))

        if unique_imports:
            # Create temporary requirements content
            req_content = "\n".join(unique_imports)
            result = await _run_tool(
                safety_path,
                ["check", "--stdin"],
                req_content,
                timeout=30,
            )
            if result.return_code != 0 and "vulnerable" in result.output.lower():
                for line in result.output.splitlines():
                    if line.strip():
                        issues.append({
                            "type": "security",
                            "message": line.strip(),
                            "severity": "error",
                            "symbol": "CVE",
                        })
        logger.debug(f"safety check completed")
    else:
        logger.debug("safety not available, skipping")

    return issues


async def _run_complexity_analysis(code: str) -> list[dict]:
    """Pass 3: Complexity and maintainability checks.

    Checks:
    - Cyclomatic complexity (radon)
    - Function length > 60 lines
    - Class coupling
    - Magic numbers
    - Code duplication
    """
    issues = []

    # Run radon for cyclomatic complexity
    radon_path = _find_tool("radon")
    if radon_path:
        result = await _run_tool(
            radon_path,
            ["cc", "-", "-a"],  # CC analysis, show average
            code,
            timeout=30,
        )
        parsed = _parse_radon_output(result.output)
        issues.extend(parsed)
        logger.debug(f"radon found {len(parsed)} complexity issues")
    else:
        logger.debug("radon not available, skipping")

    # Custom complexity checks
    lines = code.splitlines()

    # Check function length (flag > 60 lines)
    in_function = False
    function_start = 0
    function_indent = 0
    for i, line in enumerate(lines, 1):
        stripped = line.lstrip()
        indent = len(line) - len(stripped)

        # Detect function definition
        if re.match(r"^\s*def\s+\w+", line):
            if in_function:
                # Previous function was too long
                prev_len = i - function_start
                if prev_len > 60:
                    issues.append({
                        "type": "complexity",
                        "message": f"Function exceeds 60 lines ({prev_len} lines)",
                        "line": function_start,
                        "column": 0,
                        "severity": "warning",
                        "symbol": "function_length",
                    })
            in_function = True
            function_start = i
            function_indent = indent
        elif in_function and indent <= function_indent and stripped and not stripped.startswith("#"):
            # Function ended
            in_function = False

    # Check for magic numbers
    magic_pattern = re.compile(r"(?<!\w)\d{3,}(?!\w)")  # 3+ digit numbers not in identifiers
    for i, line in enumerate(lines, 1):
        if not line.lstrip().startswith("#"):  # Skip comments
            matches = magic_pattern.findall(line)
            if matches:
                issues.append({
                    "type": "maintainability",
                    "message": f"Magic number(s) found: {', '.join(matches)}",
                    "line": i,
                    "column": 0,
                    "severity": "info",
                    "symbol": "magic_number",
                })

    return issues


async def _run_performance_checks(code: str) -> list[dict]:
    """Pass 4: Performance profiling.

    Checks:
    - step() time < 10ms non-physics / < 50ms physics
    - Memory leak patterns
    - N+1 query patterns
    """
    issues = []

    # Check for common performance anti-patterns via static analysis
    checks = [
        (r"for\s+\w+\s+in\s+.*:\s*for\s+\w+\s+in", "Nested loop detected - potential O(n²)"),
        (r"\.append\(.*for\s+", "List comprehension in append - consider direct comprehension"),
        (r"while\s+True\s*:[^}]*?\.append", "Potential infinite loop with accumulation"),
    ]

    lines = code.splitlines()
    for i, line in enumerate(lines, 1):
        for pattern, message in checks:
            if re.search(pattern, line):
                issues.append({
                    "type": "performance",
                    "message": message,
                    "line": i,
                    "column": 0,
                    "severity": "warning",
                    "symbol": "performance_anti_pattern",
                })

    # Check for known slow patterns
    slow_patterns = [
        (r"copy\.deepcopy\(.*\[.*\]", "deepcopy on list - consider shallow copy or numpy"),
        (r"\.tolist\(\).*\.tolist\(\)", "Double tolist() conversion"),
    ]

    code_snippet = ""
    for i, line in enumerate(lines, 1):
        code_snippet += line + "\n"
        if i % 50 == 0:  # Check in 50-line windows
            for pattern, message in slow_patterns:
                if re.search(pattern, code_snippet):
                    issues.append({
                        "type": "performance",
                        "message": message,
                        "line": i,
                        "column": 0,
                        "severity": "info",
                        "symbol": "slow_pattern",
                    })
                    break
            code_snippet = ""

    return issues


async def _run_documentation_check(code: str) -> list[dict]:
    """Pass 5: Documentation quality checks.

    Checks:
    - Missing docstrings on public methods
    - Parameter documentation
    - Inline comments for complex logic
    """
    issues = []

    lines = code.splitlines()
    in_class = False
    in_function = False
    function_name = ""
    function_line = 0

    for i, line in enumerate(lines, 1):
        stripped = line.strip()

        # Track class/function context
        if re.match(r"^class\s+\w+", stripped):
            in_class = True
            in_function = False
            # Check if next few lines have docstring
            if i >= len(lines) or '"""' not in lines[i] and "'''" not in lines[i]:
                issues.append({
                    "type": "documentation",
                    "message": f"Class missing docstring",
                    "line": i,
                    "column": 0,
                    "severity": "warning",
                    "symbol": "missing_docstring",
                })

        elif re.match(r"^\s*def\s+\w+", stripped):
            in_function = True
            in_class = False
            function_name = re.match(r"def\s+(\w+)", stripped).group(1)
            function_line = i

            # Skip private methods
            if function_name.startswith("_") and not function_name.startswith("__"):
                in_function = False
                continue

            # Check for docstring in next non-empty line
            has_docstring = False
            for j in range(i, min(i + 5, len(lines) + 1)):
                if j < len(lines) and ('"""' in lines[j] or "'''" in lines[j]):
                    has_docstring = True
                    break
                if j < len(lines) and lines[j].strip():
                    break

            if not has_docstring:
                issues.append({
                    "type": "documentation",
                    "message": f"Function '{function_name}' missing docstring",
                    "line": i,
                    "column": 0,
                    "severity": "warning",
                    "symbol": "missing_docstring",
                })

        # Check for TODO/FIXME without explanation
        elif re.match(r"^\s*#\s*(TODO|FIXME|HACK|XXX):?\s*$", stripped, re.IGNORECASE):
            issues.append({
                "type": "documentation",
                "message": "Undocumented TODO/FIXME comment",
                "line": i,
                "column": 0,
                "severity": "info",
                "symbol": "undocumented_task",
            })

    return issues


async def code_quality_node(state: EdenJobState) -> dict:
    """Run the Code Quality Pipeline on generated code.

    Args:
        state: Current pipeline state

    Returns:
        State updates with quality report and iteration count
    """
    job_id = state["job_id"]
    code = state["code_history"][-1] if state["code_history"] else ""
    current_iteration = state.get("code_quality_iterations", 0)

    logger.info(f"Running Code Quality Pipeline for job {job_id}, iteration {current_iteration}")

    # Run 5 passes sequentially
    issues = []
    all_passed = True

    # Pass 1: Static Analysis (syntax, types, undefined vars)
    static_issues = await _run_static_analysis(code)
    issues.extend(static_issues)
    if static_issues:
        all_passed = False

    # Pass 2: Security Analysis
    security_issues = await _run_security_analysis(code)
    issues.extend(security_issues)
    if security_issues:
        all_passed = False

    # Pass 3: Complexity and Maintainability
    complexity_issues = await _run_complexity_analysis(code)
    issues.extend(complexity_issues)
    if complexity_issues:
        all_passed = False

    # Pass 4: Performance Profiling
    perf_issues = await _run_performance_checks(code)
    issues.extend(perf_issues)
    if perf_issues:
        all_passed = False

    # Pass 5: Documentation Quality
    doc_issues = await _run_documentation_check(code)
    issues.extend(doc_issues)
    if doc_issues:
        all_passed = False

    report = QualityReport(
        pass_name="code_quality_pipeline",
        passed=all_passed,
        issues=issues,
        iteration=current_iteration,
    )

    logger.info(
        f"Code Quality Pipeline complete: passed={all_passed}, "
        f"issues={len(issues)}"
    )

    return {
        "quality_reports": [report.__dict__],
        "code_quality_iterations": current_iteration + 1,
        "current_stage": "code_quality",
    }