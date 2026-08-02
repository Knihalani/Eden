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

logger = logging.getLogger(__name__)

_MAX_FILES = 8
_MAX_FILE_BYTES = 32_000
_MAX_PACK_CHARS = 6_000


def static_check_files(
    files: list[dict[str, Any]],
) -> dict[str, Any]:
    """Free syntax checks on patched file contents (stdlib only).

    ``.py`` → ``ast.parse``; ``.json`` → ``json.loads``. Unknown
    extensions are skipped (do not fail). Returns
    ``{status, errors, files_checked, files_skipped}``.
    """
    errors: list[dict[str, str]] = []
    checked = 0
    skipped = 0
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
        else:
            skipped += 1

    status = "failed" if errors else "passed"
    return {
        "status": status,
        "errors": errors,
        "files_checked": checked,
        "files_skipped": skipped,
    }


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
    one redaction path.
    """
    from eden.issues.fixture_export import export_issue_fixture

    exported = await export_issue_fixture(org_id, issue_id)
    if exported.get("status") != "ok":
        return {
            "status": exported.get("status") or "error",
            "example_trace_ids": [],
            "excerpt": "",
            "fixture": None,
        }

    fixture = exported.get("fixture") or {}
    traces = fixture.get("traces") or []
    example_ids: list[str] = []
    for t in traces[:3]:
        tid = t.get("trace_id") if isinstance(t, dict) else None
        if isinstance(tid, str) and tid.strip():
            example_ids.append(tid.strip())

    excerpt = _pack_excerpt(fixture)
    return {
        "status": "ok",
        "example_trace_ids": example_ids,
        "excerpt": excerpt,
        "fixture": fixture,
        "format": fixture.get("format") or "eden-failure-fixture-v1",
    }


def _pack_excerpt(fixture: dict[str, Any]) -> str:
    """Compact text for the patch LLM (not the full fixture JSON)."""
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
    text = "\n".join(parts)
    return text[:_MAX_PACK_CHARS]


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
        static = static_check_files(files_after)
        detail["static_check"] = {
            "status": static.get("status"),
            "errors": static.get("errors") or [],
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
        status = "passed" if apply_status == "passed" else "skipped"
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
        status = "passed" if apply_status == "passed" else "skipped"
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
        result = {"status": "passed", "detail": detail}
    elif errors and not any_checkpoints:
        result = {"status": "failed", "detail": detail}
    elif any_checkpoints:
        detail["reason"] = "hermetic_rerun_ok"
        result = {"status": "passed", "detail": detail}
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
    # Map skipped → cancelled so we stay within the CHECK constraint.
    db_status = {
        "passed": "passed",
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
