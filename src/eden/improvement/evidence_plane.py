"""Autonomy evidence plane — failure packs, file hydration, hermetic preverify.

Feeds N20 ``propose_plan_for_issue`` with real bad-run artifacts and
source file contents, then records a hermetic/fixture smoke check on
the bound example traces (Phase 1–2 of the autonomy evidence plane).

Free static preverify (diff apply + syntax) is a hard signal for the
fix→PR loop; hermetic debugger rerun stays secondary/soft.
"""

from __future__ import annotations

import ast
import json
import logging
import uuid
from pathlib import PurePosixPath
from typing import Any

from eden.prompt_safety import wrap_untrusted_data

logger = logging.getLogger(__name__)

_MAX_FILES = 8
_MAX_FILE_BYTES = 32_000
_MAX_PACK_CHARS = 6_000


def static_check_files(
    files: list[dict[str, Any]],
    *,
    hunk_ranges: dict[str, list[tuple[int, int]]] | None = None,
) -> dict[str, Any]:
    """Free syntax checks on patched file contents (stdlib + PyYAML).

    ``.py`` → ``ast.parse``; ``.json`` → ``json.loads``; ``.yaml/.yml``
    → ``yaml.safe_load``; ``.toml`` → ``tomllib``. M7 (spec §4.5):
    ``.ts/.tsx/.js/.jsx/.go`` get a string/comment-aware bracket +
    string-termination balance heuristic (``kind="balance_heuristic"``).
    Heuristic findings count as *failures* only when the patch hunks
    touch the unbalanced region (``hunk_ranges`` maps path → list of
    1-based ``(start, end)`` target-line ranges); otherwise — including
    when no hunk info is available — they are recorded as warnings.
    Unknown extensions are skipped (do not fail). Returns
    ``{status, errors, warnings, files_checked, files_skipped}``.
    """
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, Any]] = []
    checked = 0
    skipped = 0
    ranges_by_path = hunk_ranges or {}
    for item in files:
        path = str(item.get("path") or "").strip()
        content = item.get("content")
        if content is None:
            content = ""
        if not isinstance(content, str):
            content = str(content)
        if not path:
            skipped += 1
            continue
        suffix = PurePosixPath(path).suffix.lower()
        if suffix == ".py":
            checked += 1
            try:
                ast.parse(content, filename=path)
            except SyntaxError as exc:
                loc = f"line {exc.lineno}" if exc.lineno else "unknown line"
                msg = exc.msg or "syntax error"
                errors.append(
                    {
                        "path": path,
                        "kind": "python_syntax",
                        "message": f"{msg} ({loc})",
                    }
                )
            except Exception as exc:
                errors.append(
                    {
                        "path": path,
                        "kind": "python_syntax",
                        "message": str(exc)[:400],
                    }
                )
        elif suffix == ".json":
            checked += 1
            try:
                json.loads(content)
            except json.JSONDecodeError as exc:
                errors.append(
                    {
                        "path": path,
                        "kind": "json_syntax",
                        "message": f"{exc.msg} (line {exc.lineno})",
                    }
                )
            except Exception as exc:
                errors.append(
                    {
                        "path": path,
                        "kind": "json_syntax",
                        "message": str(exc)[:400],
                    }
                )
        elif suffix in (".yaml", ".yml"):
            checked += 1
            err = _check_yaml(path, content)
            if err is not None:
                errors.append(err)
        elif suffix == ".toml":
            checked += 1
            err = _check_toml(path, content)
            if err is not None:
                errors.append(err)
        elif suffix in _BALANCE_SUFFIXES:
            checked += 1
            # Backtick strings cover both JS template literals and Go
            # raw strings, so the scanner treats them alike.
            issues = _scan_balance(content)
            for issue in issues:
                entry = {
                    "path": path,
                    "kind": "balance_heuristic",
                    "message": str(issue.get("message") or "")[:400],
                    "line_start": issue.get("line_start"),
                    "line_end": issue.get("line_end"),
                }
                if _issue_touches_hunks(issue, ranges_by_path.get(path)):
                    errors.append(entry)
                else:
                    # False-positive guard (spec §4.5): unbalanced
                    # region the patch never touched → warning only.
                    warnings.append(entry)
        else:
            skipped += 1

    status = "failed" if errors else "passed"
    return {
        "status": status,
        "errors": errors,
        "warnings": warnings,
        "files_checked": checked,
        "files_skipped": skipped,
    }


_BALANCE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".go")
#: Line slack when intersecting an unbalanced region with patch hunks.
_HUNK_SLACK_LINES = 2


def _check_yaml(path: str, content: str) -> dict[str, Any] | None:
    try:
        import yaml
    except Exception:
        return None  # PyYAML unavailable → treat as skipped-with-label
    try:
        yaml.safe_load(content)
        return None
    except yaml.YAMLError as exc:
        line = None
        mark = getattr(exc, "problem_mark", None)
        if mark is not None:
            line = int(getattr(mark, "line", 0)) + 1
        loc = f" (line {line})" if line else ""
        return {
            "path": path,
            "kind": "yaml_syntax",
            "message": f"{exc}"[:400] + loc,
        }
    except Exception as exc:
        return {"path": path, "kind": "yaml_syntax", "message": str(exc)[:400]}


def _check_toml(path: str, content: str) -> dict[str, Any] | None:
    import tomllib

    try:
        tomllib.loads(content)
        return None
    except tomllib.TOMLDecodeError as exc:
        return {"path": path, "kind": "toml_syntax", "message": str(exc)[:400]}
    except Exception as exc:
        return {"path": path, "kind": "toml_syntax", "message": str(exc)[:400]}


def _issue_touches_hunks(
    issue: dict[str, Any],
    ranges: list[tuple[int, int]] | None,
) -> bool:
    """Line-distance heuristic: unbalanced region ∩ hunk target ranges.

    Unknown hunk info (``ranges is None``) → not attributable to the
    patch → False (caller records a warning, not a failure).

    Issues whose region inherently spans opener→EOF (unclosed bracket,
    unterminated backtick string / block comment) use *endpoint* touch
    instead of full-range intersection — otherwise every hunk anywhere
    in the file would count as touching, defeating the guard. A patch
    that truncates the file touches the EOF endpoint; a pre-existing
    imbalance far from the hunks stays a warning.
    """
    if not ranges:
        return False
    start = int(issue.get("line_start") or 0)
    end = int(issue.get("line_end") or start)
    for lo, hi in ranges:
        lo_s = int(lo) - _HUNK_SLACK_LINES
        hi_s = int(hi) + _HUNK_SLACK_LINES
        if issue.get("endpoints_only"):
            if lo_s <= start <= hi_s or lo_s <= end <= hi_s:
                return True
        elif start <= hi_s and lo_s <= end:
            return True
    return False


def _scan_balance(
    content: str,
    *,
    backtick_strings: bool = True,
) -> list[dict[str, Any]]:
    """String/comment-aware bracket + string-termination scanner.

    Catches the dominant LLM truncation class (spec §4.5): unclosed
    ``([{``, mismatched closers, unterminated strings, and unterminated
    block comments. ``'``/``"`` strings honor backslash escapes and must
    end on their line; backtick strings (JS templates, Go raw strings)
    may span lines. ``//`` line comments and ``/* */`` block comments
    are ignored. Deliberately heuristic — no toolchain dependency.
    """
    issues: list[dict[str, Any]] = []
    pairs = {")": "(", "]": "[", "}": "{"}
    openers = set(pairs.values())
    stack: list[tuple[str, int]] = []  # (char, line)
    line = 1
    i = 0
    n = len(content)
    in_line_comment = False
    block_comment_start: int | None = None
    string_quote: str | None = None
    string_start_line = 0

    while i < n:
        ch = content[i]
        nxt = content[i + 1] if i + 1 < n else ""
        if ch == "\n":
            if string_quote in ("'", '"'):
                issues.append(
                    {
                        "message": f"unterminated {string_quote} string",
                        "line_start": string_start_line,
                        "line_end": string_start_line,
                    }
                )
                string_quote = None
            in_line_comment = False
            line += 1
            i += 1
            continue
        if in_line_comment:
            i += 1
            continue
        if block_comment_start is not None:
            if ch == "*" and nxt == "/":
                block_comment_start = None
                i += 2
                continue
            i += 1
            continue
        if string_quote is not None:
            if ch == "\\" and string_quote != "`":
                i += 2
                continue
            if ch == string_quote:
                string_quote = None
            i += 1
            continue
        if ch == "/" and nxt == "/":
            in_line_comment = True
            i += 2
            continue
        if ch == "/" and nxt == "*":
            block_comment_start = line
            i += 2
            continue
        if ch in ("'", '"') or (ch == "`" and backtick_strings):
            string_quote = ch
            string_start_line = line
            i += 1
            continue
        if ch in openers:
            stack.append((ch, line))
        elif ch in pairs:
            if not stack:
                issues.append(
                    {
                        "message": f"unmatched closing {ch!r}",
                        "line_start": line,
                        "line_end": line,
                    }
                )
            elif stack[-1][0] != pairs[ch]:
                issues.append(
                    {
                        "message": (
                            f"mismatched closing {ch!r} "
                            f"(open {stack[-1][0]!r} at line {stack[-1][1]})"
                        ),
                        "line_start": stack[-1][1],
                        "line_end": line,
                    }
                )
                stack.pop()
            else:
                stack.pop()
        i += 1

    if string_quote == "`":
        issues.append(
            {
                "message": "unterminated ` string",
                "line_start": string_start_line,
                "line_end": line,
                "endpoints_only": True,
            }
        )
    elif string_quote is not None:
        issues.append(
            {
                "message": f"unterminated {string_quote} string",
                "line_start": string_start_line,
                "line_end": string_start_line,
            }
        )
    if block_comment_start is not None:
        issues.append(
            {
                "message": "unterminated block comment",
                "line_start": block_comment_start,
                "line_end": line,
                "endpoints_only": True,
            }
        )
    for opener, opened_at in stack[:3]:
        issues.append(
            {
                "message": f"unclosed {opener!r} opened at line {opened_at}",
                "line_start": opened_at,
                "line_end": line,
                "endpoints_only": True,
            }
        )
    return issues


def format_static_errors_for_prompt(errors: list[dict[str, Any]]) -> str:
    """Compact feedback block for PatchGenerator regenerate prompts."""
    if not errors:
        return ""
    lines = ["Static preverify failed — fix these issues:"]
    for err in errors[:12]:
        path = err.get("path") or "?"
        kind = err.get("kind") or "error"
        message = err.get("message") or ""
        lines.append(f"- [{kind}] {path}: {message}")
    return "\n".join(lines)


async def build_failure_pack(org_id: str, issue_id: str) -> dict[str, Any]:
    """Return a size-capped redacted failure pack + example trace ids.

    Reuses D6 :func:`export_issue_fixture` so PatchGenerator / MCP share
    one redaction path. M12 (§7.2): re-apply value-level redaction at
    this choke point so secrets never leave the pack even if an upstream
    path skipped ``_redact``.
    """
    from eden.issues.fixture_export import (
        _redact,
        export_issue_fixture,
        redact_secret_values,
    )

    exported = await export_issue_fixture(org_id, issue_id)
    if exported.get("status") != "ok":
        return {
            "status": exported.get("status") or "error",
            "example_trace_ids": [],
            "excerpt": "",
            "fixture": None,
        }

    # M12 (§7.2) choke point: deep value-level redaction before excerpt /
    # signature / plan evidence consume the fixture.
    fixture = _redact(exported.get("fixture") or {})
    traces = fixture.get("traces") or []
    example_ids: list[str] = []
    for t in traces[:3]:
        tid = t.get("trace_id") if isinstance(t, dict) else None
        if isinstance(tid, str) and tid.strip():
            example_ids.append(tid.strip())

    excerpt = redact_secret_values(_pack_excerpt(fixture))
    return {
        "status": "ok",
        "example_trace_ids": example_ids,
        "excerpt": excerpt,
        "fixture": fixture,
        "format": fixture.get("format") or "eden-failure-fixture-v1",
        # M7 (§4.1): machine-checkable failure signature for replay verify.
        "failure_signature": _redact(_pack_failure_signature(fixture)),
    }


def _pack_failure_signature(fixture: dict[str, Any]) -> dict[str, Any] | None:
    """Extract the failure signature from the fixture traces (pure)."""
    try:
        from eden.improvement.replay_verify import extract_failure_signature

        for trace in (fixture.get("traces") or [])[:3]:
            if not isinstance(trace, dict):
                continue
            detail = trace.get("detail") or (trace.get("stumble") or {}).get(
                "detail"
            )
            span_attrs = None
            for span in trace.get("spans") or []:
                if isinstance(span, dict) and isinstance(
                    span.get("attributes"), dict
                ):
                    attrs = span["attributes"]
                    if any(
                        attrs.get(k)
                        for k in (
                            "error",
                            "exception.message",
                            "otel.status_description",
                        )
                    ):
                        # The span *name* lives on the span object, not
                        # in its attributes — carry it along.
                        span_attrs = {**attrs, "span_name": span.get("name")}
                        break
            sig = extract_failure_signature(
                detail if isinstance(detail, dict) else {}, span_attrs
            )
            if sig is not None:
                return sig.to_json()
    except Exception as exc:
        logger.debug("evidence_plane: signature extraction failed: %s", exc)
    return None


def _pack_excerpt(fixture: dict[str, Any]) -> str:
    """Compact text for the patch LLM (not the full fixture JSON).

    M11 (§7.1): the whole excerpt is untrusted production evidence —
    wrap it in randomized ``<<EDEN_DATA_*>>`` delimiters after
    truncating so markers stay intact.
    """
    parts: list[str] = []
    issue = fixture.get("issue") or {}
    if issue:
        parts.append(
            f"fingerprint={issue.get('fingerprint')} kind={issue.get('kind')} "
            f"severity={issue.get('severity')} title={issue.get('title')}"
        )
    for t in (fixture.get("traces") or [])[:3]:
        if not isinstance(t, dict):
            continue
        tid = t.get("trace_id") or "?"
        parts.append(f"--- trace {tid} ---")
        detail = t.get("detail") or (t.get("stumble") or {}).get("detail")
        if detail:
            try:
                blob = json.dumps(detail, default=str)
            except Exception:
                blob = str(detail)
            parts.append(blob[:1_500])
        for span in (t.get("spans") or [])[:8]:
            if not isinstance(span, dict):
                continue
            name = span.get("name") or ""
            attrs = span.get("attributes") or {}
            err = ""
            if isinstance(attrs, dict):
                err = str(
                    attrs.get("error")
                    or attrs.get("exception.message")
                    or attrs.get("otel.status_description")
                    or ""
                )[:240]
            parts.append(f"span={name} {err}".strip())
        if t.get("error"):
            parts.append(f"fetch_error={t.get('error')}")
    text = "\n".join(parts)[:_MAX_PACK_CHARS]
    return wrap_untrusted_data(text)


async def hydrate_linked_files(
    org_id: str,
    paths: list[dict[str, str]],
    *,
    agent_id: str | None = None,
) -> list[dict[str, str]]:
    """Fill ``content`` via :func:`get_repo_provider_for_org` + ``read_file``.

    Skips missing/empty/binary-looking files. Caps count and bytes.
    """
    if not paths:
        return []
    try:
        from eden.providers.factory import get_repo_provider_for_org

        provider = await get_repo_provider_for_org(org_id, agent_id=agent_id)
    except Exception as exc:
        logger.debug("evidence_plane: repo provider unavailable: %s", exc)
        return [p for p in paths if (p.get("content") or "").strip()]

    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in paths:
        if len(out) >= _MAX_FILES:
            break
        path = (item.get("path") or "").strip()
        if not path or path in seen:
            continue
        seen.add(path)
        existing = item.get("content") or ""
        content = existing
        if not content.strip():
            try:
                content = await provider.read_file(path) or ""
            except Exception as exc:
                logger.debug("evidence_plane: read_file %s failed: %s", path, exc)
                content = ""
        if not content.strip():
            continue
        if "\x00" in content[:1024]:
            continue
        if len(content.encode("utf-8", errors="replace")) > _MAX_FILE_BYTES:
            content = content[:_MAX_FILE_BYTES]
        out.append({"path": path, "content": content})
    return out


async def apply_diff_to_files(
    diff: str,
    linked_files: list[dict[str, str]],
    *,
    run_static: bool = True,
) -> dict[str, Any]:
    """Apply a unified diff to in-memory linked file contents.

    Returns ``{status, detail}`` where status is passed|failed|skipped.
    On success ``detail.files_after`` includes ``content`` for each
    patched file. When ``run_static`` is True (default), free syntax
    checks run after apply and fail the result on parse errors.
    """
    import hashlib

    from eden.patches.diff_materializer import (
        DiffMaterializeError,
        _apply_hunks,
        _parse_unified_diff_files,
        _strip_prefix,
    )

    diff = (diff or "").strip()
    if not diff:
        return {
            "status": "skipped",
            "detail": {"reason": "empty_diff"},
        }

    by_path = {
        str(f.get("path") or ""): str(f.get("content") or "")
        for f in linked_files
        if f.get("path")
    }
    if not by_path:
        return {
            "status": "skipped",
            "detail": {"reason": "no_linked_file_content"},
        }

    try:
        parsed = _parse_unified_diff_files(diff)
    except Exception as exc:
        return {
            "status": "failed",
            "detail": {"reason": f"diff_parse_error:{exc}"},
        }

    if not parsed:
        return {
            "status": "failed",
            "detail": {"reason": "no_file_hunks_in_diff"},
        }

    files_after: list[dict[str, Any]] = []
    hunk_ranges: dict[str, list[tuple[int, int]]] = {}
    try:
        for fd in parsed:
            path = _strip_prefix(str(fd.new_path or fd.old_path or ""))
            if not path or path == "/dev/null":
                continue
            base = by_path.get(path)
            if base is None:
                for k, v in by_path.items():
                    if k.endswith(path) or path.endswith(k):
                        path, base = k, v
                        break
            if base is None:
                raise DiffMaterializeError(f"linked content missing for {path}")
            after = _apply_hunks(base, fd.hunks, path=path)
            # M7 (§4.5): 1-based target-line ranges the patch touches —
            # the balance heuristic only *fails* inside these.
            hunk_ranges[path] = [
                (int(h.new_start), int(h.new_start) + max(int(h.new_count), 1) - 1)
                for h in fd.hunks
            ]
            files_after.append(
                {
                    "path": path,
                    "content": after,
                    "before_sha": hashlib.sha256(
                        base.encode("utf-8", errors="replace")
                    ).hexdigest()[:16],
                    "after_sha": hashlib.sha256(
                        after.encode("utf-8", errors="replace")
                    ).hexdigest()[:16],
                    "changed": after != base,
                }
            )
    except DiffMaterializeError as exc:
        return {
            "status": "failed",
            "detail": {"reason": "diff_apply_failed", "error": str(exc)[:400]},
        }
    except Exception as exc:
        return {
            "status": "failed",
            "detail": {"reason": f"diff_apply_error:{exc}"},
        }

    if not files_after:
        return {
            "status": "failed",
            "detail": {"reason": "no_applicable_files"},
        }

    detail: dict[str, Any] = {
        "reason": "diff_applied",
        "files_after": files_after,
        "files_changed": sum(1 for f in files_after if f.get("changed")),
    }

    if run_static:
        static = static_check_files(files_after, hunk_ranges=hunk_ranges)
        detail["static_check"] = {
            "status": static.get("status"),
            "errors": static.get("errors") or [],
            "warnings": static.get("warnings") or [],
            "files_checked": static.get("files_checked"),
            "files_skipped": static.get("files_skipped"),
        }
        if static.get("status") == "failed":
            detail["reason"] = "static_syntax_failed"
            return {"status": "failed", "detail": detail}

    return {"status": "passed", "detail": detail}


async def run_hermetic_preverify(
    org_id: str,
    issue_id: str,
    *,
    example_trace_ids: list[str],
    fingerprint: str = "",
    diff_unified: str = "",
    linked_files: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Preverify: apply patch + free syntax, then hermetic rerun on traces.

    Diff apply and static syntax are hard signals. Hermetic debugger
    rerun is secondary evidence that bound traces are loadable.
    Persists ``issue_verifications`` with ``ref=hermetic_preverify``.

    M7 (§4.1) honest labels: the success status is ``"static_passed"``
    — nothing here executes the patched code, so it must not claim more
    than static evidence. Readers accept both ``"passed"`` (legacy
    rows/evidence) and ``"static_passed"``. The ``issue_verifications``
    DB status stays ``"passed"`` (CHECK constraint); the honest label
    lives in the ``detail`` jsonb + plan evidence.
    """
    detail: dict[str, Any] = {
        "kind": "hermetic_preverify",
        "example_trace_ids": list(example_trace_ids)[:5],
        "traces_checked": [],
    }

    apply_result = await apply_diff_to_files(
        diff_unified, list(linked_files or []), run_static=True
    )
    apply_detail = apply_result.get("detail") or {}
    detail["diff_apply"] = apply_detail
    detail["static_check"] = apply_detail.get("static_check") or {}
    apply_status = str(apply_result.get("status") or "skipped")

    if apply_status == "failed":
        # Hard fail: diff did not apply or patched files failed syntax.
        result = {"status": "failed", "detail": detail}
        await _persist_preverify(org_id, issue_id, fingerprint, result)
        return result

    # Secondary: hermetic / fixture smoke on example traces.
    if not example_trace_ids:
        detail["reason"] = (
            "diff_ok_no_example_traces"
            if apply_status == "passed"
            else "no_example_traces"
        )
        status = "static_passed" if apply_status == "passed" else "skipped"
        result = {"status": status, "detail": detail}
        await _persist_preverify(org_id, issue_id, fingerprint, result)
        return result

    try:
        from eden.debugger.checkpoints import CheckpointStore, ReRunEngine
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
        store = CheckpointStore(pg)
        engine = ReRunEngine(store)
    except Exception as exc:
        detail["reason"] = f"debugger_unavailable:{exc}"
        # Diff apply + static still count if they passed.
        status = "static_passed" if apply_status == "passed" else "skipped"
        result = {"status": status, "detail": detail}
        await _persist_preverify(org_id, issue_id, fingerprint, result)
        return result

    any_checkpoints = False
    errors: list[str] = []
    for tid in example_trace_ids[:3]:
        entry: dict[str, Any] = {"trace_id": tid}
        try:
            cps = await store.list_for_trace(tid, org_id=org_id)
            entry["checkpoint_count"] = len(cps)
            if cps:
                any_checkpoints = True
                rerun = await engine.rerun(tid, from_step=0, org_id=org_id)
                entry["rerun_from"] = rerun.from_step
                entry["rerun_to"] = rerun.to_step
                entry["diff_len"] = len(rerun.diff or [])
            else:
                entry["note"] = "no_debugger_checkpoints"
        except Exception as exc:
            entry["error"] = str(exc)[:240]
            errors.append(str(exc)[:120])
        detail["traces_checked"].append(entry)

    if apply_status == "passed":
        detail["reason"] = "diff_applied"
        if any_checkpoints:
            detail["reason"] = "diff_applied_and_hermetic_ok"
        result = {"status": "static_passed", "detail": detail}
    elif errors and not any_checkpoints:
        result = {"status": "failed", "detail": detail}
    elif any_checkpoints:
        detail["reason"] = "hermetic_rerun_ok"
        result = {"status": "static_passed", "detail": detail}
    else:
        detail["reason"] = "fixture_only_no_checkpoints"
        result = {"status": "skipped", "detail": detail}

    await _persist_preverify(org_id, issue_id, fingerprint, result)
    return result


async def _persist_preverify(
    org_id: str,
    issue_id: str,
    fingerprint: str,
    result: dict[str, Any],
) -> None:
    """Insert a completed issue_verifications row for hermetic preverify."""
    status = result.get("status") or "skipped"
    # Map skipped → cancelled so we stay within the CHECK constraint
    # (pending/passed/failed/cancelled). M7: the honest "static_passed"
    # label maps to DB "passed"; the label itself lives in detail jsonb.
    db_status = {
        "passed": "passed",
        "static_passed": "passed",
        "failed": "failed",
        "skipped": "cancelled",
    }.get(str(status), "cancelled")
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        detail = result.get("detail") or {}
        await client.execute(
            """
            INSERT INTO issue_verifications
                (id, org_id, issue_id, fingerprint, ref, scheduled_at,
                 status, attempts, detail, completed_at)
            VALUES (
                $1::uuid, $2, $3::uuid, $4, 'hermetic_preverify', NOW(),
                $5, 1, $6::jsonb, NOW()
            )
            """,
            str(uuid.uuid4()),
            org_id,
            issue_id,
            (fingerprint or "")[:64],
            db_status,
            json.dumps(detail, default=str),
        )
    except Exception as exc:
        logger.debug("evidence_plane: persist preverify failed: %s", exc)


__all__ = [
    "apply_diff_to_files",
    "build_failure_pack",
    "format_static_errors_for_prompt",
    "hydrate_linked_files",
    "run_hermetic_preverify",
    "static_check_files",
]
