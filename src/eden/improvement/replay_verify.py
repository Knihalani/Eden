"""M7 (spec §4.1) — signature-based replay-before-PR verification.

Replaces "critic said PASS" with executable evidence: extract a
machine-checkable **failure signature** from the issue's failure pack,
find the failing step in a checkpointed example trace, re-execute that
step live through the AI gateway with the *patched* prompt context, and
check that the signature is present in the original trace but absent
from the replayed output.

Honesty notes (what is actually replayable today):

* ``ReRunEngine.rerun`` (debugger/checkpoints.py) is **hermetic** — it
  returns the *recorded* responses, so a patch can never change its
  output. It is used here only to construct the patched input context
  (its ``prompt_override`` seam) — never as proof the failure went away.
* ``TraceReplayer`` (time_travel/replayer.py) re-executes live through
  the gateway but requires a pre-existing fork and only surfaces a
  response *hash*, so signature checking is impossible through it.
* Therefore the only honest replay today is: patches whose old content
  appears in the failing checkpoint's input messages (prompt/config
  shaped changes). For those we re-execute the single failing step live
  via :func:`_gateway_complete` and evaluate the signature on the real
  response text. Code-only patches with no injection point into the
  replayed step are **downgraded to** ``skipped:not_replayable`` rather
  than pretending (spec §4.1 demands honest labels).

Exact-output comparison is deliberately absent — LLM non-determinism
makes it meaningless (spec §11); the check is signature-based only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any

logger = logging.getLogger(__name__)

_MAX_TRACES = 2
_SUBSTRING_CAP = 120
#: Wall-clock budget for the trace-evaluation phase (monkeypatchable).
_REPLAY_WALL_CLOCK_S = 60.0
#: Minimum stem length for the span-name applicability match — shorter
#: stems ("x", "db") match traced text far too easily.
_MIN_STEM_LEN = 3

_PROMPT_CONFIG_SUFFIXES = {
    ".md",
    ".txt",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".jinja",
    ".j2",
    ".tmpl",
    ".prompt",
}
_PROMPT_NAME_HINTS = ("prompt", "template", "instruction", "system")

_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)
_HEX_RE = re.compile(r"\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b", re.IGNORECASE)
_NUM_RE = re.compile(r"\d+")
_WS_RE = re.compile(r"\s+")

_DIFF_PATH_RE = re.compile(r"^\+\+\+ (?:b/)?(\S+)", re.MULTILINE)


# ── Failure signature ───────────────────────────────────────────


def normalize_error_text(text: str) -> str:
    """Lowercase + strip ids/uuids/numbers to placeholders + collapse ws.

    Pure. Applied identically to the signature substring and to every
    haystack so volatile fragments (request ids, counts, addresses)
    never break the containment check.
    """
    out = (text or "").lower()
    out = _UUID_RE.sub("<id>", out)
    out = _HEX_RE.sub("<id>", out)
    out = _NUM_RE.sub("<n>", out)
    out = _WS_RE.sub(" ", out)
    return out.strip()


@dataclass(frozen=True)
class FailureSignature:
    """The machine-checkable "what was wrong" (spec §4.1)."""

    stumble_kind: str
    error_substring: str
    failing_span_name: str
    judge_dimension: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "stumble_kind": self.stumble_kind,
            "error_substring": self.error_substring,
            "failing_span_name": self.failing_span_name,
            "judge_dimension": self.judge_dimension,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> FailureSignature | None:
        if not isinstance(data, dict):
            return None
        sub = str(data.get("error_substring") or "").strip()
        if not sub:
            return None
        dim = data.get("judge_dimension")
        return cls(
            stumble_kind=str(data.get("stumble_kind") or ""),
            error_substring=sub,
            failing_span_name=str(data.get("failing_span_name") or ""),
            judge_dimension=str(dim) if dim else None,
        )


def extract_failure_signature(
    stumble_detail: dict[str, Any],
    span_attrs: dict[str, Any] | None = None,
) -> FailureSignature | None:
    """Pure extraction from stumble detail + span attributes.

    Returns ``None`` when no usable error text exists — a signature
    without an error substring is not machine-checkable.
    """
    detail = stumble_detail if isinstance(stumble_detail, dict) else {}
    attrs = span_attrs if isinstance(span_attrs, dict) else {}

    kind = str(
        detail.get("kind")
        or detail.get("stumble_kind")
        or detail.get("type")
        or ""
    ).strip()

    raw_error = ""
    for key in ("error", "error_message", "message", "exception", "reason"):
        val = detail.get(key)
        if isinstance(val, str) and val.strip():
            raw_error = val
            break
    if not raw_error:
        for key in ("error", "exception.message", "otel.status_description"):
            val = attrs.get(key)
            if isinstance(val, str) and val.strip():
                raw_error = val
                break
    error_substring = normalize_error_text(raw_error)[:_SUBSTRING_CAP]
    if not error_substring:
        return None

    span_name = str(
        attrs.get("span_name")
        or attrs.get("name")
        or detail.get("span_name")
        or detail.get("failing_span")
        or ""
    ).strip()

    dim = detail.get("judge_dimension") or detail.get("dimension")
    judge_dimension = str(dim).strip() if dim else None

    return FailureSignature(
        stumble_kind=kind,
        error_substring=error_substring,
        failing_span_name=span_name,
        judge_dimension=judge_dimension,
    )


def signature_present(text_or_payload: Any, sig: FailureSignature) -> bool:
    """True when the normalized signature appears in the content.

    Primary check: normalized ``error_substring`` containment. When the
    signature also names a judge dimension, its mention alongside the
    span name counts as presence (judge-stumble packs often carry the
    dimension rather than the raw error text).
    """
    if text_or_payload is None:
        return False
    if isinstance(text_or_payload, (dict, list)):
        try:
            haystack = json.dumps(text_or_payload, default=str)
        except Exception:
            haystack = str(text_or_payload)
    else:
        haystack = str(text_or_payload)
    normalized = normalize_error_text(haystack)

    if sig.error_substring and sig.error_substring in normalized:
        return True
    if sig.judge_dimension and sig.failing_span_name:
        dim = normalize_error_text(sig.judge_dimension)
        span = normalize_error_text(sig.failing_span_name)
        if dim and span and dim in normalized and span in normalized:
            return True
    return False


# ── Applicability ───────────────────────────────────────────────


def _diff_file_paths(diff: str) -> list[str]:
    """Target paths from a unified diff (pure, regex-based)."""
    out: list[str] = []
    for match in _DIFF_PATH_RE.findall(diff or ""):
        path = match.strip()
        if path and path != "/dev/null" and path not in out:
            out.append(path)
    return out


def _traced_names_text(failure_pack: dict[str, Any]) -> str:
    """Concatenated span/tool names + excerpt from the failure pack."""
    parts: list[str] = [str(failure_pack.get("excerpt") or "")]
    fixture = failure_pack.get("fixture") or {}
    for trace in (fixture.get("traces") or [])[:5]:
        if not isinstance(trace, dict):
            continue
        for span in (trace.get("spans") or [])[:20]:
            if isinstance(span, dict):
                parts.append(str(span.get("name") or ""))
                attrs = span.get("attributes")
                if isinstance(attrs, dict):
                    parts.append(str(attrs.get("tool_name") or ""))
        for call in (trace.get("tool_calls") or [])[:20]:
            if isinstance(call, dict):
                parts.append(str(call.get("name") or ""))
    return " ".join(p for p in parts if p).lower()


def is_replayable(
    diff_files: list[str],
    failure_pack: dict[str, Any],
) -> tuple[bool, str]:
    """Does the patch plausibly affect the replayed step?

    True for prompt/config/tool-arg-shaped changes, or when a patched
    file's stem appears in the traced span/tool names. Everything else
    is an honest ``(False, "not_replayable")``.
    """
    pack = failure_pack if isinstance(failure_pack, dict) else {}
    traced = _traced_names_text(pack)
    for raw in diff_files or []:
        path = str(raw or "").strip()
        if not path:
            continue
        p = PurePosixPath(path)
        name = p.name.lower()
        if p.suffix.lower() in _PROMPT_CONFIG_SUFFIXES:
            return True, "prompt_or_config_change"
        if any(hint in name for hint in _PROMPT_NAME_HINTS):
            return True, "prompt_or_config_change"
        stem = p.stem.lower()
        if len(stem) >= _MIN_STEM_LEN and stem in traced:
            return True, "file_in_traced_spans"
    return False, "not_replayable"


# ── Result envelope ─────────────────────────────────────────────


@dataclass
class ReplayResult:
    """Outcome of :func:`run_replay_verify` — honest by construction."""

    status: str  # "passed" | "failed" | "skipped"
    reason: str
    cost_usd: float = 0.0
    traces_checked: int = 0
    details: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "reason": self.reason,
            "cost_usd": round(self.cost_usd, 6),
            "traces_checked": self.traces_checked,
            "details": self.details,
        }


def _skipped(reason: str, **details: Any) -> ReplayResult:
    return ReplayResult(status="skipped", reason=reason, details=dict(details))


# ── Injection seams (monkeypatchable in tests) ──────────────────


def _settings_enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "replay_verify_enabled", True))
    except Exception:
        return True


async def _org_enabled(org_id: str) -> bool:
    """Org kill-switch (spec §10.2 marks this flag org-overridable)."""
    try:
        from eden.preview.gates import replay_verify_enabled_for_org

        return await replay_verify_enabled_for_org(org_id)
    except Exception:
        return _settings_enabled()


async def _get_checkpoint_store() -> Any | None:
    try:
        from eden.debugger.checkpoints import CheckpointStore
        from eden.storage.postgres import get_postgres_client

        pg = await get_postgres_client()
        if pg is None:
            return None
        return CheckpointStore(pg)
    except Exception as exc:
        logger.debug("replay_verify: checkpoint store unavailable: %s", exc)
        return None


async def _gateway_complete(
    org_id: str,
    model: str,
    prompt: str,
) -> dict[str, Any]:
    """One live gateway completion — PII filter / audit / cost apply.

    Mirrors ``TraceReplayer._re_execute_step`` but keeps the response
    *text* so the signature can actually be evaluated.
    """
    from eden.api.routes.gateway import get_ai_gateway
    from eden.llmops.ai_gateway import ModelRequest

    gw = get_ai_gateway()
    req = ModelRequest(
        model_family=model.split("/")[-1].split(":")[0] if model else "default",
        model_version=model,
        prompt=prompt,
        tenant_id=org_id,
        estimated_tokens=len(prompt.split()),
    )
    resp = await gw.complete(req)
    return {
        "text": resp.text,
        "cost_usd": float(resp.cost_usd or 0.0),
    }


# ── Core ────────────────────────────────────────────────────────


def _checkpoint_output_text(checkpoint: Any) -> str:
    """The output side of a checkpoint (response + tool results)."""
    try:
        blob = {
            "response": checkpoint.response,
            "tool_results": checkpoint.tool_results,
        }
        return json.dumps(blob, default=str)
    except Exception:
        return str(getattr(checkpoint, "response", ""))


def _messages_text(messages: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
    return "\n".join(parts)


def _patched_prompt_for_step(
    checkpoint: Any,
    file_edits: list[tuple[str, str, str]],
) -> tuple[str | None, str | None]:
    """Build the patched prompt for the failing step, honestly.

    ``file_edits`` is ``[(path, before, after)]``. An injection point
    exists only when a patched file's old content actually appears in
    the step's input messages (whitespace-normalized containment).

    Returns ``(patched_prompt, patched_system)``; both ``None`` when
    the patch cannot affect this step (→ not replayable for it).
    """
    messages = list(getattr(checkpoint, "input_messages", None) or [])
    if not messages:
        return None, None

    def _norm(text: str) -> str:
        return _WS_RE.sub(" ", text or "").strip()

    changed = False
    patched_system: str | None = None
    patched_messages: list[dict[str, Any]] = []
    for msg in messages:
        if not isinstance(msg, dict) or not isinstance(msg.get("content"), str):
            patched_messages.append(msg)
            continue
        content = str(msg["content"])
        new_content = content
        for _path, before, after in file_edits:
            if not before.strip():
                continue
            if before in new_content:
                new_content = new_content.replace(before, after)
            elif _norm(before) and _norm(before) == _norm(new_content):
                # Whole-message prompt file (whitespace drift tolerated).
                new_content = after
        if new_content != content:
            changed = True
            if msg.get("role") == "system":
                patched_system = new_content
        out = dict(msg)
        out["content"] = new_content
        patched_messages.append(out)

    if not changed:
        return None, None
    return _messages_text(patched_messages), patched_system


async def _evaluate_traces(
    org_id: str,
    sig: FailureSignature,
    trace_ids: list[str],
    file_edits: list[tuple[str, str, str]],
    *,
    max_llm_steps: int,
    max_cost_usd: float,
) -> ReplayResult:
    from eden.debugger.checkpoints import ReRunEngine
    from eden.improvement.sweep_budget import try_consume_llm_call

    store = await _get_checkpoint_store()
    if store is None:
        return _skipped("no_checkpoints")

    per_trace: list[dict[str, Any]] = []
    absent = 0
    present = 0
    llm_steps = 0
    cost_total = 0.0
    any_checkpoints = False
    capped_reason: str | None = None

    engine = ReRunEngine(store)
    for trace_id in trace_ids:
        try:
            checkpoints = await store.list_for_trace(trace_id, org_id=org_id)
        except Exception as exc:
            per_trace.append(
                {"trace_id": trace_id, "skip": f"checkpoint_load_error:{exc}"[:200]}
            )
            continue
        if not checkpoints:
            per_trace.append({"trace_id": trace_id, "skip": "no_checkpoints"})
            continue
        any_checkpoints = True

        # Signature must be present in the ORIGINAL trace content.
        failing = None
        for cp in checkpoints:
            if signature_present(_checkpoint_output_text(cp), sig):
                failing = cp
                break
        if failing is None:
            per_trace.append(
                {"trace_id": trace_id, "skip": "signature_absent_in_original"}
            )
            continue

        prompt, patched_system = _patched_prompt_for_step(failing, file_edits)
        if patched_system is not None:
            # Route through the debugger substrate: the rerun applies
            # the system-prompt override to the replayed step's inputs.
            try:
                rerun = await engine.rerun(
                    trace_id,
                    from_step=failing.step_number,
                    prompt_override=patched_system,
                    org_id=org_id,
                )
                if rerun.checkpoints:
                    prompt = _messages_text(rerun.checkpoints[0].input_messages)
            except Exception as exc:
                logger.debug("replay_verify: rerun failed: %s", exc)
        if not prompt:
            per_trace.append({"trace_id": trace_id, "skip": "no_injection_point"})
            continue

        # Caps — checked before every live LLM step.
        if llm_steps >= max_llm_steps:
            capped_reason = "cost_cap"
            per_trace.append({"trace_id": trace_id, "skip": "llm_step_cap"})
            break
        if not try_consume_llm_call():
            capped_reason = "cost_cap"
            per_trace.append({"trace_id": trace_id, "skip": "llm_budget_exhausted"})
            break

        model = ""
        if isinstance(failing.response, dict):
            model = str(failing.response.get("model") or "")
        try:
            out = await _gateway_complete(org_id, model, prompt)
        except Exception as exc:
            per_trace.append(
                {"trace_id": trace_id, "skip": f"gateway_error:{exc}"[:200]}
            )
            continue
        llm_steps += 1
        cost_total += float(out.get("cost_usd") or 0.0)

        in_replay = signature_present(out.get("text") or "", sig)
        per_trace.append(
            {
                "trace_id": trace_id,
                "from_step": failing.step_number,
                "signature_in_original": True,
                "signature_in_replay": in_replay,
                "used_prompt_override": patched_system is not None,
            }
        )
        if in_replay:
            present += 1
        else:
            absent += 1

        if cost_total >= max_cost_usd:
            capped_reason = "cost_cap"
            break

    details: dict[str, Any] = {
        "per_trace": per_trace,
        "signature": sig.to_json(),
        "llm_steps": llm_steps,
    }
    evaluated = absent + present
    if evaluated == 0:
        if capped_reason:
            return ReplayResult(
                status="skipped",
                reason=capped_reason,
                cost_usd=cost_total,
                traces_checked=0,
                details=details,
            )
        if not any_checkpoints:
            return ReplayResult(
                status="skipped",
                reason="no_checkpoints",
                cost_usd=cost_total,
                traces_checked=0,
                details=details,
            )
        skips = {str(e.get("skip") or "") for e in per_trace}
        if skips <= {"no_injection_point"}:
            # Patch cannot be injected into any replayed step — honest
            # downgrade rather than pretending (code-only changes).
            reason = "not_replayable"
        elif skips <= {"signature_absent_in_original", "no_injection_point"}:
            reason = "signature_absent_in_original"
        else:
            reason = "replay_error"
        return ReplayResult(
            status="skipped",
            reason=reason,
            cost_usd=cost_total,
            traces_checked=0,
            details=details,
        )
    if present == 0:
        return ReplayResult(
            status="passed",
            reason="signature_absent_in_replay",
            cost_usd=cost_total,
            traces_checked=evaluated,
            details=details,
        )
    if absent == 0:
        return ReplayResult(
            status="failed",
            reason="signature_still_present",
            cost_usd=cost_total,
            traces_checked=evaluated,
            details=details,
        )
    # Contradictory traces — not proof either way.
    return ReplayResult(
        status="skipped",
        reason="inconclusive",
        cost_usd=cost_total,
        traces_checked=evaluated,
        details=details,
    )


async def run_replay_verify(
    org_id: str,
    issue_id: str,
    diff: str,
    linked_files: list[dict[str, str]],
    failure_pack: dict[str, Any],
) -> ReplayResult:
    """Signature-based replay of the failing step with the patched context.

    Never raises. Status taxonomy: ``passed`` (signature in original,
    absent in replay), ``failed`` (still present in every replay),
    ``skipped:<reason>`` for every honest non-answer (disabled,
    not_replayable, no_checkpoints, no_signature, cost_cap, timeout, …).
    """
    started = time.monotonic()
    pack = failure_pack if isinstance(failure_pack, dict) else {}

    if not _settings_enabled():
        return _skipped("disabled")

    diff_files = _diff_file_paths(diff)
    ok, why = is_replayable(diff_files, pack)
    if not ok:
        return _skipped(why, diff_files=diff_files[:8])

    sig = FailureSignature.from_json(pack.get("failure_signature") or {})
    if sig is None:
        # Fall back to extracting from the pack fixture (pure).
        try:
            for trace in (pack.get("fixture") or {}).get("traces") or []:
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
                        span_attrs = span["attributes"]
                        break
                sig = extract_failure_signature(detail or {}, span_attrs)
                if sig is not None:
                    break
        except Exception as exc:
            logger.debug("replay_verify: signature extraction failed: %s", exc)
    if sig is None:
        return _skipped("no_signature")

    if not await _org_enabled(org_id):
        return _skipped("disabled")

    trace_ids = [
        str(t).strip()
        for t in (pack.get("example_trace_ids") or [])
        if str(t or "").strip()
    ][:_MAX_TRACES]
    if not trace_ids:
        return _skipped("no_checkpoints")

    # Patched file contents — old vs new, for context injection.
    try:
        from eden.improvement.evidence_plane import apply_diff_to_files

        applied = await apply_diff_to_files(
            diff, list(linked_files or []), run_static=False
        )
    except Exception as exc:
        return _skipped("not_replayable", error=str(exc)[:200])
    if applied.get("status") != "passed":
        return _skipped(
            "not_replayable",
            error=str((applied.get("detail") or {}).get("reason") or "")[:200],
        )
    before_by_path = {
        str(f.get("path") or ""): str(f.get("content") or "")
        for f in linked_files or []
        if f.get("path")
    }
    file_edits: list[tuple[str, str, str]] = []
    for item in (applied.get("detail") or {}).get("files_after") or []:
        path = str(item.get("path") or "")
        if not path or not item.get("changed"):
            continue
        before = before_by_path.get(path, "")
        file_edits.append((path, before, str(item.get("content") or "")))
    if not file_edits:
        return _skipped("not_replayable", error="patch_changes_nothing")

    try:
        from eden.config import get_settings

        settings = get_settings()
        max_llm_steps = int(getattr(settings, "replay_max_llm_steps", 3) or 3)
        max_cost_usd = float(
            getattr(settings, "replay_max_cost_usd", 0.05) or 0.05
        )
    except Exception:
        max_llm_steps, max_cost_usd = 3, 0.05

    try:
        result = await asyncio.wait_for(
            _evaluate_traces(
                org_id,
                sig,
                trace_ids,
                file_edits,
                max_llm_steps=max_llm_steps,
                max_cost_usd=max_cost_usd,
            ),
            timeout=_REPLAY_WALL_CLOCK_S,
        )
    except TimeoutError:
        return _skipped("timeout", wall_clock_s=_REPLAY_WALL_CLOCK_S)
    except Exception as exc:
        logger.warning("replay_verify: unexpected error: %s", exc)
        return _skipped("replay_error", error=str(exc)[:200])

    result.details.setdefault(
        "duration_ms", int((time.monotonic() - started) * 1000)
    )
    result.details.setdefault("issue_id", issue_id)
    return result


__all__ = [
    "FailureSignature",
    "ReplayResult",
    "extract_failure_signature",
    "is_replayable",
    "normalize_error_text",
    "run_replay_verify",
    "signature_present",
]
