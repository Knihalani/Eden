"""Layer A detectors — structural + high-precision semantic heuristics.

Goal: approach SLM-level agent labeling without a neural net by combining
exact structural checks with calibrated lexical/trajectory heuristics.
"""

from __future__ import annotations

import contextlib
import json
import re
from collections.abc import Callable
from typing import Any

from eden.evaluation.descriptors.long_agent import LONG_AGENT_DETECTORS
from eden.evaluation.descriptors.parse import TrajectoryView, is_failure_outcome
from eden.evaluation.descriptors.signals import (
    CHITCHAT_RE,
    CLARIFICATION_RE,
    FRUSTRATION_RE,
    INCOMPLETE_RE,
    JAILBREAK_RE,
    MCP_AUTH_RE,
    PII_RE,
    PLAN_MARKER_RE,
    REFUSAL_RE,
    SUCCESS_CLAIM_RE,
    content_overlap_ratio,
    entropy_of_args,
    extract_salient_tokens,
    fuzzy_token_in_text,
    intent_keywords,
    is_empty_payload,
    is_soft_utu,
    jaccard,
    normalize_args_for_similarity,
    normalize_text,
    numbers_in,
    strong_anchors,
    tokenize,
    tool_matches_intent,
)
from eden.evaluation.descriptors.taxonomy import DISPLAY_NAMES, DescriptorId

_DEFAULT_LOOP_REPEAT = 3
_DEFAULT_MAX_TOOL_CALLS = 12
_DEFAULT_TIMEOUT_MS = 60_000.0
_DEFAULT_COST_SPIKE_USD = 1.0
_CLARIFY_THRESHOLD = 3


def _result(
    descriptor_id: str,
    *,
    rationale: str,
    confidence: float = 1.0,
    evidence: dict[str, Any] | None = None,
    span_id: str | None = None,
) -> dict[str, Any]:
    return {
        "descriptor_id": descriptor_id,
        "display_name": DISPLAY_NAMES.get(descriptor_id, descriptor_id),
        "confidence": float(min(1.0, max(0.0, confidence))),
        "rationale": rationale,
        "evidence": evidence or {},
        "span_id": span_id,
        "source": "layer_a",
    }


# ── Structural ────────────────────────────────────────────────────


def detect_bad_tool_args(view: TrajectoryView) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for tc in view.tool_calls:
        key_base = f"{tc.name}|{tc.args_canonical}"
        if tc.parse_error:
            if key_base in seen:
                continue
            seen.add(key_base)
            out.append(
                _result(
                    DescriptorId.BAD_TOOL_ARGS.value,
                    rationale=f"Tool '{tc.name}' arguments are not valid JSON",
                    evidence={"tool_name": tc.name, "reason": "json_parse_error"},
                    span_id=tc.span_id,
                )
            )
            continue
        schema = view.tool_schemas.get(tc.name)
        if not schema:
            continue
        args = tc.args if isinstance(tc.args, dict) else None
        if args is None:
            if schema.get("type") == "object" or "properties" in schema:
                if key_base in seen:
                    continue
                seen.add(key_base)
                out.append(
                    _result(
                        DescriptorId.BAD_TOOL_ARGS.value,
                        rationale=f"Tool '{tc.name}' expected an object of arguments",
                        evidence={"tool_name": tc.name, "reason": "expected_object"},
                        span_id=tc.span_id,
                    )
                )
            continue
        required = schema.get("required") or []
        props = schema.get("properties") or {}
        missing = [r for r in required if isinstance(r, str) and r not in args]
        if missing:
            sig = f"{tc.name}|missing:{','.join(sorted(missing))}"
            if sig in seen:
                continue
            seen.add(sig)
            out.append(
                _result(
                    DescriptorId.BAD_TOOL_ARGS.value,
                    rationale=f"Tool '{tc.name}' missing required args: {', '.join(missing)}",
                    evidence={
                        "tool_name": tc.name,
                        "reason": "missing_required",
                        "missing": missing,
                    },
                    span_id=tc.span_id,
                )
            )
            continue
        type_mismatches: list[str] = []
        enum_mismatches: list[str] = []
        for key, prop in props.items() if isinstance(props, dict) else []:
            if key not in args or not isinstance(prop, dict):
                continue
            expected = prop.get("type")
            if expected and not _json_type_ok(args[key], expected):
                type_mismatches.append(f"{key}:{expected}")
            enum = prop.get("enum")
            if isinstance(enum, list) and args[key] not in enum:
                enum_mismatches.append(key)
        if type_mismatches:
            sig = f"{tc.name}|types:{','.join(type_mismatches)}"
            if sig not in seen:
                seen.add(sig)
                out.append(
                    _result(
                        DescriptorId.BAD_TOOL_ARGS.value,
                        rationale=f"Tool '{tc.name}' argument type mismatch: {', '.join(type_mismatches)}",
                        evidence={
                            "tool_name": tc.name,
                            "reason": "type_mismatch",
                            "mismatches": type_mismatches,
                        },
                        span_id=tc.span_id,
                    )
                )
        elif enum_mismatches:
            sig = f"{tc.name}|enum:{','.join(enum_mismatches)}"
            if sig not in seen:
                seen.add(sig)
                out.append(
                    _result(
                        DescriptorId.BAD_TOOL_ARGS.value,
                        rationale=f"Tool '{tc.name}' argument not in enum: {', '.join(enum_mismatches)}",
                        evidence={
                            "tool_name": tc.name,
                            "reason": "enum_mismatch",
                            "fields": enum_mismatches,
                        },
                        span_id=tc.span_id,
                        confidence=0.95,
                    )
                )
    return out


def _json_type_ok(val: Any, expected: str | list[Any]) -> bool:
    if isinstance(expected, list):
        return any(_json_type_ok(val, e) for e in expected if isinstance(e, str))
    if expected == "string":
        return isinstance(val, str)
    if expected == "number":
        return isinstance(val, (int, float)) and not isinstance(val, bool)
    if expected == "integer":
        return isinstance(val, int) and not isinstance(val, bool)
    if expected == "boolean":
        return isinstance(val, bool)
    if expected == "object":
        return isinstance(val, dict)
    if expected == "array":
        return isinstance(val, list)
    if expected == "null":
        return val is None
    return True


def detect_tool_errors(view: TrajectoryView) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for tr in view.tool_results:
        err = tr.error
        failed = bool(err) or is_failure_outcome(tr.outcome)
        if not failed and tr.content:
            low = tr.content.lower()
            if re.search(
                r"\b(internal server error|traceback|exception|status\"?\s*:\s*5\d\d)\b",
                low,
            ):
                failed = True
                err = err or "error_in_tool_payload"
        if not failed:
            continue
        name = tr.name or "unknown"
        error_text = err or tr.outcome or "tool_error"
        if MCP_AUTH_RE.search(error_text):
            continue
        sig = f"{name}|{error_text}"
        if sig in seen:
            continue
        seen.add(sig)
        out.append(
            _result(
                DescriptorId.TOOL_ERROR.value,
                rationale=f"Tool '{name}' failed: {error_text}",
                evidence={"tool_name": name, "error": error_text, "outcome": tr.outcome},
            )
        )
    return out


def detect_empty_tool_result(view: TrajectoryView) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for tr in view.tool_results:
        if tr.error or is_failure_outcome(tr.outcome):
            continue
        if not is_empty_payload(tr.content):
            continue
        name = tr.name or "unknown"
        out.append(
            _result(
                DescriptorId.EMPTY_TOOL_RESULT.value,
                rationale=f"Tool '{name}' returned an empty payload",
                evidence={"tool_name": name},
                confidence=0.9,
            )
        )
        break
    return out


def detect_mcp_auth(view: TrajectoryView) -> list[dict[str, Any]]:
    for tr in view.tool_results:
        blob = f"{tr.error or ''} {tr.content or ''}"
        if MCP_AUTH_RE.search(blob):
            return [
                _result(
                    DescriptorId.MCP_AUTH_FAILURE.value,
                    rationale=f"Tool '{tr.name or 'unknown'}' returned an authentication/authorization failure",
                    evidence={"tool_name": tr.name, "error": tr.error},
                )
            ]
    return []


def detect_error_swallow(view: TrajectoryView) -> list[dict[str, Any]]:
    """Tool failed, but final answer claims success / ignores the error."""
    failed = [
        tr
        for tr in view.tool_results
        if tr.error or is_failure_outcome(tr.outcome)
    ]
    if not failed or not view.assistant_messages:
        return []
    final = view.final_assistant_text
    if not final:
        return []
    if SUCCESS_CLAIM_RE.search(final) and not re.search(
        r"\b(error|failed|couldn't|could not|unable)\b", final, re.I
    ):
        names = sorted({(tr.name or "tool") for tr in failed})
        return [
            _result(
                DescriptorId.ERROR_SWALLOW.value,
                rationale=f"Tool(s) failed ({', '.join(names)}) but answer claims success",
                evidence={"failed_tools": names, "final_excerpt": final[:200]},
                confidence=0.9,
            )
        ]
    return []


def detect_timeout(view: TrajectoryView) -> list[dict[str, Any]]:
    threshold = view.timeout_ms if view.timeout_ms is not None else _DEFAULT_TIMEOUT_MS
    max_ms = 0.0
    timed_out = False
    for e in view.events:
        with contextlib.suppress(TypeError, ValueError):
            max_ms = max(max_ms, float(e.get("duration_ms") or 0.0))
        outcome = str(e.get("outcome") or "").lower()
        finish = str(e.get("finish_reason") or "").lower()
        et = str(e.get("event_type") or "").lower()
        name = str(e.get("name") or "").lower()
        if outcome == "timeout" or "timeout" in finish or (
            "timeout" in str(e.get("error") or "").lower()
            and "tool" not in et
            and (
                e.get("parent_span_id") is None
                or name in {"trace", "span.end", "session"}
            )
        ):
            timed_out = True
    if timed_out or max_ms > threshold:
        return [
            _result(
                DescriptorId.TIMEOUT.value,
                rationale=(
                    f"Trace exceeded timeout budget ({max_ms:.0f}ms > {threshold:.0f}ms)"
                    if max_ms > threshold and not timed_out
                    else "Trace marked as timeout"
                ),
                evidence={"max_duration_ms": max_ms, "threshold_ms": threshold},
                confidence=1.0 if timed_out or max_ms > threshold * 1.5 else 0.9,
            )
        ]
    return []


def detect_loops(
    view: TrajectoryView, *, repeat_threshold: int = _DEFAULT_LOOP_REPEAT
) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    soft_counts: dict[str, int] = {}
    for tc in view.tool_calls:
        key = f"{tc.name}|{tc.args_canonical}"
        counts[key] = counts.get(key, 0) + 1
        soft = f"{tc.name}|{normalize_args_for_similarity(tc.args_canonical)}"
        soft_counts[soft] = soft_counts.get(soft, 0) + 1

    out: list[dict[str, Any]] = []
    best = max(counts.items(), key=lambda kv: kv[1], default=(None, 0))
    soft_best = max(soft_counts.items(), key=lambda kv: kv[1], default=(None, 0))
    # Prefer soft-normalized match when it reveals retries with volatile fields
    use_soft = (
        soft_best[0] is not None
        and soft_best[1] >= repeat_threshold
        and (best[0] is None or soft_best[1] > best[1])
    )
    chosen_key, chosen_n = (soft_best if use_soft else best)
    if chosen_key is not None and chosen_n >= repeat_threshold:
        tool_name = chosen_key.split("|", 1)[0]
        out.append(
            _result(
                DescriptorId.REPETITIVE_TOOL_CALL.value,
                rationale=f"Tool '{tool_name}' called {chosen_n}× with identical arguments",
                evidence={
                    "repeated_step": chosen_key[:240],
                    "repeat_count": chosen_n,
                    "threshold": repeat_threshold,
                    "normalized": use_soft,
                },
            )
        )
        out.append(
            _result(
                DescriptorId.LOOPING.value,
                rationale=f"Agent loop: identical tool+args repeated {chosen_n} times",
                evidence={
                    "repeated_step": chosen_key[:240],
                    "repeat_count": chosen_n,
                    "kind": "identical_tool_args_normalized" if use_soft else "identical_tool_args",
                },
            )
        )
        return out

    by_name: dict[str, list[str]] = {}
    for tc in view.tool_calls:
        by_name.setdefault(tc.name, []).append(
            normalize_args_for_similarity(tc.args_canonical) or tc.args_canonical
        )

    for name, arg_list in by_name.items():
        if len(arg_list) < repeat_threshold:
            continue
        unique = set(arg_list)
        if len(arg_list) >= repeat_threshold + 2 and len(unique) <= 2:
            out.append(
                _result(
                    DescriptorId.LOOPING.value,
                    rationale=f"Agent loop: tool '{name}' invoked {len(arg_list)}× with little argument diversity",
                    evidence={
                        "tool_name": name,
                        "call_count": len(arg_list),
                        "unique_args": len(unique),
                        "kind": "low_diversity",
                        "arg_entropy": round(entropy_of_args(arg_list), 3),
                    },
                    confidence=0.85,
                )
            )
            return out
        distinct = list(unique)
        if len(arg_list) >= repeat_threshold and len(distinct) >= 2:
            token_sets = [tokenize(a) for a in distinct]
            similar_pairs = 0
            for i in range(len(token_sets)):
                for j in range(i + 1, len(token_sets)):
                    if jaccard(token_sets[i], token_sets[j]) >= 0.75:
                        similar_pairs += 1
            if similar_pairs >= 1:
                out.append(
                    _result(
                        DescriptorId.LOOPING.value,
                        rationale=f"Agent loop: tool '{name}' called {len(arg_list)}× with near-duplicate arguments",
                        evidence={
                            "tool_name": name,
                            "call_count": len(arg_list),
                            "similar_pairs": similar_pairs,
                            "kind": "near_duplicate_args",
                        },
                        confidence=0.9,
                    )
                )
                return out

    # Alternating 2-step tool cycle: A,B,A,B,A,B
    names = [tc.name for tc in view.tool_calls]
    if len(names) >= 6 and (
        names[0::2] == [names[0]] * (len(names[0::2]))
        and names[1::2] == [names[1]] * (len(names[1::2]))
        and names[0] != names[1]
    ):
        out.append(
            _result(
                DescriptorId.LOOPING.value,
                rationale=f"Agent loop: alternating tools '{names[0]}'↔'{names[1]}'",
                evidence={"kind": "alternating_cycle", "tools": [names[0], names[1]]},
                confidence=0.88,
            )
        )
    return out


def detect_confusion_loop(view: TrajectoryView) -> list[dict[str, Any]]:
    questions = 0
    for text in view.assistant_messages:
        if CLARIFICATION_RE.search(text or ""):
            questions += 1
    if questions >= _CLARIFY_THRESHOLD:
        return [
            _result(
                DescriptorId.CONFUSION_LOOP.value,
                rationale=f"Assistant asked clarifying questions {questions} times without resolving",
                evidence={"clarification_count": questions},
                confidence=0.85,
            )
        ]
    return []


def detect_excessive_clarification(view: TrajectoryView) -> list[dict[str, Any]]:
    # Distinct from confusion_loop: clarifications with zero tool progress
    if view.tool_calls:
        return []
    n = sum(1 for t in view.assistant_messages if CLARIFICATION_RE.search(t or ""))
    if n >= 2 and len(view.user_messages) >= 2:
        return [
            _result(
                DescriptorId.EXCESSIVE_CLARIFICATION.value,
                rationale=f"Agent clarified {n}× without calling tools or answering",
                evidence={"clarification_count": n},
                confidence=0.8,
            )
        ]
    return []


def detect_excessive_steps(view: TrajectoryView) -> list[dict[str, Any]]:
    budget = view.max_tool_calls if view.max_tool_calls is not None else _DEFAULT_MAX_TOOL_CALLS
    n = len(view.tool_calls)
    if n <= budget:
        return []
    return [
        _result(
            DescriptorId.EXCESSIVE_STEPS.value,
            rationale=f"Agent made {n} tool calls (budget {budget})",
            evidence={"tool_call_count": n, "budget": budget},
        )
    ]


def detect_cost_spike(view: TrajectoryView) -> list[dict[str, Any]]:
    total = 0.0
    for e in view.events:
        metrics = e.get("metrics") or {}
        if isinstance(metrics, dict):
            with contextlib.suppress(TypeError, ValueError):
                total += float(metrics.get("cost_usd") or 0.0)
        attrs = e.get("attributes") or {}
        if isinstance(attrs, dict) and attrs.get("cost_usd") is not None:
            with contextlib.suppress(TypeError, ValueError):
                total += float(attrs["cost_usd"])
    threshold = _DEFAULT_COST_SPIKE_USD
    pol = None
    for e in view.events:
        attrs = e.get("attributes") or {}
        if isinstance(attrs, dict):
            pol = attrs.get("layer_a_policy") or pol
    if isinstance(pol, dict) and pol.get("cost_spike_usd") is not None:
        with contextlib.suppress(TypeError, ValueError):
            threshold = float(pol["cost_spike_usd"])
    if total > threshold:
        return [
            _result(
                DescriptorId.COST_SPIKE.value,
                rationale=f"Trace cost ${total:.4f} exceeds ${threshold:.2f}",
                evidence={"cost_usd": total, "threshold_usd": threshold},
                confidence=0.95,
            )
        ]
    return []


# ── Result grounding ──────────────────────────────────────────────


def detect_result_ignore(view: TrajectoryView) -> list[dict[str, Any]]:
    if not view.tool_results or not view.assistant_messages:
        return []
    useful: list[tuple[str, set[str]]] = []
    for tr in view.tool_results:
        if tr.error or is_failure_outcome(tr.outcome):
            continue
        if is_empty_payload(tr.content) or len((tr.content or "").strip()) < 8:
            continue
        strong = strong_anchors(extract_salient_tokens(tr.content))
        if not strong:
            continue
        useful.append((tr.name or "tool", strong))
    if not useful:
        return []

    answer = normalize_text(view.all_assistant_text)
    ignored: list[dict[str, Any]] = []
    partial: list[dict[str, Any]] = []
    for name, strong in useful:
        hits = [t for t in strong if fuzzy_token_in_text(t, answer)]
        if not hits:
            ignored.append({"tool_name": name, "unused_tokens": sorted(strong)[:8]})
        elif (
            len(hits) < len(strong)
            and len(strong) >= 2
            and len(hits) / len(strong) < 0.5
        ):
            # Partial only when a minority of anchors were used
                missed = sorted(strong - set(hits))[:8]
                partial.append(
                    {"tool_name": name, "unused_tokens": missed, "used": hits[:8]}
                )

    if ignored and not (len(ignored) == 1 and len(useful) > 2):
        # Drop ignores that are only ISO dates when other results were used
        nontrivial = []
        for item in ignored:
            toks = [
                t
                for t in item.get("unused_tokens", [])
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(t))
            ]
            if toks:
                nontrivial.append({**item, "unused_tokens": toks})
        ignored = nontrivial if nontrivial else []
    if ignored and not (len(ignored) == 1 and len(useful) > 2):
        return [
            _result(
                DescriptorId.RESULT_IGNORE.value,
                rationale="Tool result(s) contain concrete values that never appear in the assistant answer",
                evidence={"ignored": ignored},
                confidence=0.85 if len(ignored) == len(useful) else 0.75,
            )
        ]
    if partial and not ignored:
        return [
            _result(
                DescriptorId.PARTIAL_RESULT_USE.value,
                rationale="Assistant used some but not all concrete values from tool results",
                evidence={"partial": partial},
                confidence=0.7,
            )
        ]
    return []


def detect_output_fabrication(view: TrajectoryView) -> list[dict[str, Any]]:
    """Final answer invents strong anchors (IDs/numbers) absent from tools+user+args."""
    if not view.assistant_messages or not view.tool_results:
        return []
    ok_results = [
        tr
        for tr in view.tool_results
        if not tr.error and not is_failure_outcome(tr.outcome) and tr.content
    ]
    if not ok_results:
        return []
    arg_blobs = []
    for tc in view.tool_calls:
        if tc.args_canonical:
            arg_blobs.append(tc.args_canonical)
        if isinstance(tc.args, dict):
            arg_blobs.append(json.dumps(tc.args))
    context = "\n".join(
        [view.first_user_text]
        + view.user_messages
        + [tr.content for tr in ok_results]
        + arg_blobs
    )
    ctx_norm = normalize_text(context)
    # Also allow loose digit matching from user ("acct 8842" ↔ acc_8842)
    ctx_digits = set(re.findall(r"\d{3,}", context))
    ctx_nums = numbers_in(context)
    ctx_anchors = strong_anchors(extract_salient_tokens(context))

    final = view.final_assistant_text
    ans_anchors = strong_anchors(extract_salient_tokens(final))
    ans_nums = numbers_in(final)

    invented = set()
    for a in ans_anchors:
        if a.startswith(("ord_", "txn_", "acc_", "trk_", "sku_")) or "@" in a:
            if fuzzy_token_in_text(a, ctx_norm) or a in ctx_anchors:
                continue
            # digits inside prefixed id present in context?
            digs = re.findall(r"\d{3,}", a)
            if digs and all(d in ctx_digits for d in digs):
                continue
            invented.add(a)
    for n in ans_nums:
        try:
            if float(n) >= 10 and n not in ctx_nums and not fuzzy_token_in_text(n, ctx_norm):
                if re.fullmatch(r"20\d{2}", n):
                    continue
                invented.add(n)
        except ValueError:
            continue

    if not invented:
        return []
    return [
        _result(
            DescriptorId.OUTPUT_FABRICATION.value,
            rationale="Final answer introduces concrete IDs/numbers not present in tool results or user input",
            evidence={"invented": sorted(invented)[:10]},
            confidence=0.8,
        )
    ]


def detect_inaccuracy(view: TrajectoryView) -> list[dict[str, Any]]:
    """Numeric contradiction vs tool results (narrow, high precision)."""
    if not view.tool_results or not view.final_assistant_text:
        return []
    tool_nums: set[str] = set()
    for tr in view.tool_results:
        if tr.content and not tr.error:
            tool_nums |= numbers_in(tr.content)
    if len(tool_nums) < 1:
        return []
    ans_nums = numbers_in(view.final_assistant_text)
    # If answer asserts a number in same "slot" — hard without NLP.
    # Heuristic: answer contains money-like claim and none of tool nums appear
    # but answer has different money numbers.
    money_ans = {n for n in ans_nums if "." in n or float(n) >= 10}
    money_tool = {n for n in tool_nums if "." in n or (n.isdigit() and int(n) >= 10)}
    if (
        money_ans
        and money_tool
        and money_ans.isdisjoint(money_tool)
        and (
            SUCCESS_CLAIM_RE.search(view.final_assistant_text)
            or re.search(r"\$\d", view.final_assistant_text)
        )
    ):
            return [
                _result(
                    DescriptorId.INACCURACY.value,
                    rationale="Answer amounts do not match any amounts returned by tools",
                    evidence={
                        "answer_numbers": sorted(money_ans)[:8],
                        "tool_numbers": sorted(money_tool)[:8],
                    },
                    confidence=0.72,
                )
            ]
    return []


def detect_stale_tool_result(view: TrajectoryView) -> list[dict[str, Any]]:
    """Answer cites values from an older tool result after a newer one exists."""
    by_name: dict[str, list[str]] = {}
    for tr in view.tool_results:
        if tr.name and tr.content and not tr.error:
            # de-dupe consecutive identical payloads
            if by_name.get(tr.name) and by_name[tr.name][-1] == tr.content:
                continue
            by_name.setdefault(tr.name, []).append(tr.content)
    for name, contents in by_name.items():
        if len(contents) < 2:
            continue
        older, newer = contents[0], contents[-1]
        if older == newer:
            continue
        old_a = strong_anchors(extract_salient_tokens(older)) | set(
            re.findall(r"\d{4}-\d{2}-\d{2}", older)
        )
        new_a = strong_anchors(extract_salient_tokens(newer)) | set(
            re.findall(r"\d{4}-\d{2}-\d{2}", newer)
        )
        # status words
        for status in ("processing", "shipped", "delivered", "pending", "cancelled", "canceled"):
            if re.search(rf"\b{status}\b", older, re.I):
                old_a.add(status)
            if re.search(rf"\b{status}\b", newer, re.I):
                new_a.add(status)
        unique_old = old_a - new_a
        unique_new = new_a - old_a
        if not unique_old or not unique_new:
            continue
        ans = normalize_text(view.final_assistant_text)
        uses_old = any(fuzzy_token_in_text(t, ans) or t.lower() in ans for t in unique_old)
        uses_new = any(fuzzy_token_in_text(t, ans) or t.lower() in ans for t in unique_new)
        if uses_old and not uses_new:
            return [
                _result(
                    DescriptorId.STALE_TOOL_RESULT.value,
                    rationale=f"Answer cites stale values from earlier '{name}' result, ignoring the latest",
                    evidence={
                        "tool_name": name,
                        "stale_tokens": sorted(unique_old)[:8],
                        "fresh_tokens": sorted(unique_new)[:8],
                    },
                    confidence=0.78,
                )
            ]
    return []


# ── Tool selection / necessity ────────────────────────────────────


def detect_unnecessary_tool_call(view: TrajectoryView) -> list[dict[str, Any]]:
    if not view.tool_calls:
        return []
    user = (view.first_user_text or "").strip()
    if not user:
        return []
    if is_soft_utu(user) or CHITCHAT_RE.match(user):
        names = sorted({tc.name for tc in view.tool_calls})
        return [
            _result(
                DescriptorId.UNNECESSARY_TOOL_CALL.value,
                rationale=f"User message looks like chitchat/ack but agent called tool(s): {', '.join(names)}",
                evidence={
                    "user_message": user[:200],
                    "tools_called": names,
                    "kind": "soft_utu" if is_soft_utu(user) else "chitchat",
                },
                confidence=0.95 if CHITCHAT_RE.match(user) else 0.88,
            )
        ]
    # Semantic: tools called whose results have ~0 overlap with user intent tokens
    # and answer doesn't use them — only when single irrelevant tool on a clear intent
    intents = intent_keywords(user)
    if len(intents) == 1 and len(view.tool_calls) == 1:
        intent = next(iter(intents))
        name = view.tool_calls[0].name
        if not tool_matches_intent(name, intent):
            # Prefer wrong_tool; unnecessary only if answer ignores tool entirely
            return []
    return []


def detect_tool_skip(view: TrajectoryView) -> list[dict[str, Any]]:
    if not view.expected_tools:
        # Soft: strong action verbs + no tools + success claim
        user = view.first_user_text or ""
        intents = intent_keywords(user)
        actiony = bool(
            re.search(
                r"\b(transfer|cancel|refund|send|book|schedule|delete|create|update|pay)\b",
                user,
                re.I,
            )
        )
        if (
            actiony
            and intents
            and not view.tool_calls
            and view.assistant_messages
            and SUCCESS_CLAIM_RE.search(view.final_assistant_text)
        ):
                return [
                    _result(
                        DescriptorId.TOOL_SKIP.value,
                        rationale="User requested an action but no tools were called while answer claims success",
                        evidence={"intents": sorted(intents), "kind": "soft_action_without_tools"},
                        confidence=0.82,
                    )
                ]
        return []
    called = {tc.name for tc in view.tool_calls}
    missing = [t for t in view.expected_tools if t not in called]
    if not missing:
        return []
    return [
        _result(
            DescriptorId.TOOL_SKIP.value,
            rationale=f"Required tool(s) never called: {', '.join(missing)}",
            evidence={
                "expected_tools": view.expected_tools,
                "missing": missing,
                "called": sorted(called),
            },
        )
    ]


def detect_wrong_tool(view: TrajectoryView) -> list[dict[str, Any]]:
    if not view.tool_calls:
        return []
    user = view.first_user_text or ""
    intents = intent_keywords(user)
    if not intents:
        return []
    called = [tc.name for tc in view.tool_calls]
    for name in called:
        for intent in intents:
            if tool_matches_intent(name, intent):
                return []
    # Semantic boost: if answer content overlaps user but tools don't match intent
    overlap = content_overlap_ratio(user, view.final_assistant_text or "")
    conf = 0.78 if overlap < 0.15 else 0.72
    return [
        _result(
            DescriptorId.WRONG_TOOL.value,
            rationale=f"User intent {sorted(intents)} but tools called were {called}",
            evidence={
                "intents": sorted(intents),
                "tools_called": called,
                "answer_user_overlap": round(overlap, 3),
            },
            confidence=conf,
        )
    ]


def detect_extra_tool_call(view: TrajectoryView) -> list[dict[str, Any]]:
    """Tools beyond what's needed: matched intent tool + unrelated extras."""
    if len(view.tool_calls) < 2:
        return []
    user = view.first_user_text or ""
    intents = intent_keywords(user)
    if len(intents) != 1:
        return []
    intent = next(iter(intents))
    matched = [tc.name for tc in view.tool_calls if tool_matches_intent(tc.name, intent)]
    unmatched = [tc.name for tc in view.tool_calls if not tool_matches_intent(tc.name, intent)]
    if matched and unmatched:
        return [
            _result(
                DescriptorId.EXTRA_TOOL_CALL.value,
                rationale=f"Extra unrelated tool(s) {unmatched} alongside needed {matched}",
                evidence={"intent": intent, "extra": unmatched, "needed": matched},
                confidence=0.7,
            )
        ]
    return []


# ── Planning / completion ─────────────────────────────────────────


def detect_action_incomplete(view: TrajectoryView) -> list[dict[str, Any]]:
    final = view.final_assistant_text or ""
    if not final:
        # tools ran but no final answer
        if view.tool_calls:
            return [
                _result(
                    DescriptorId.ACTION_INCOMPLETE.value,
                    rationale="Tools were called but no final assistant answer was produced",
                    evidence={"kind": "missing_final"},
                    confidence=0.8,
                )
            ]
        return []
    user = view.first_user_text or ""
    actiony = bool(
        re.search(
            r"\b(transfer|cancel|refund|book|schedule|delete|create|update|pay|send)\b",
            user,
            re.I,
        )
    )
    if actiony and INCOMPLETE_RE.search(final) and not SUCCESS_CLAIM_RE.search(final):
        return [
            _result(
                DescriptorId.ACTION_INCOMPLETE.value,
                rationale="User requested an action but assistant deferred/failed to complete it",
                evidence={"kind": "deferred"},
                confidence=0.78,
            )
        ]
    # Failed tools + apology without resolution
    failed = any(tr.error or is_failure_outcome(tr.outcome) for tr in view.tool_results)
    if failed and INCOMPLETE_RE.search(final):
        return [
            _result(
                DescriptorId.ACTION_INCOMPLETE.value,
                rationale="Tool failures left the user goal incomplete",
                evidence={"kind": "failed_tools"},
                confidence=0.8,
            )
        ]
    return []


def detect_dead_end(view: TrajectoryView) -> list[dict[str, Any]]:
    """All tools failed and answer gives up."""
    if not view.tool_results:
        return []
    fails = sum(1 for tr in view.tool_results if tr.error or is_failure_outcome(tr.outcome))
    if fails == 0 or fails < len(view.tool_results):
        return []
    final = view.final_assistant_text or ""
    if INCOMPLETE_RE.search(final) or REFUSAL_RE.search(final) or not final:
        return [
            _result(
                DescriptorId.DEAD_END.value,
                rationale="Every tool call failed and the agent stopped without a resolution",
                evidence={"failed_results": fails},
                confidence=0.85,
            )
        ]
    return []


def detect_plan_drift(view: TrajectoryView) -> list[dict[str, Any]]:
    """Assistant stated a plan mentioning tools/steps then did something else."""
    if len(view.assistant_messages) < 2 or not view.tool_calls:
        return []
    plan_msgs = [m for m in view.assistant_messages[:-1] if PLAN_MARKER_RE.search(m or "")]
    if not plan_msgs:
        return []
    plan_text = normalize_text(" ".join(plan_msgs))
    planned_tools = set(re.findall(r"\b([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\b", plan_text))
    # also bare names after "call/use"
    planned_tools |= set(
        re.findall(r"(?:call|use|invoke)\s+`?([a-zA-Z0-9_.]+)`?", " ".join(plan_msgs), re.I)
    )
    if not planned_tools:
        return []
    called = {tc.name.lower() for tc in view.tool_calls}
    planned_norm = {p.lower() for p in planned_tools}
    if planned_norm.isdisjoint(called) and called:
        return [
            _result(
                DescriptorId.PLAN_DRIFT.value,
                rationale=f"Stated plan mentioned {sorted(planned_norm)} but called {sorted(called)}",
                evidence={"planned": sorted(planned_norm), "called": sorted(called)},
                confidence=0.7,
            )
        ]
    return []


def detect_no_progress(view: TrajectoryView) -> list[dict[str, Any]]:
    """Many steps, entropy of args near 0, no new information in results."""
    if len(view.tool_calls) < 4:
        return []
    args = [tc.args_canonical for tc in view.tool_calls]
    if entropy_of_args(args) > 0.5:
        return []
    # results nearly identical
    contents = [tr.content for tr in view.tool_results if tr.content]
    if len(contents) >= 3 and len(set(contents)) <= 2:
        return [
            _result(
                DescriptorId.NO_PROGRESS.value,
                rationale="Repeated tool calls produced little/no new information",
                evidence={
                    "tool_calls": len(view.tool_calls),
                    "unique_results": len(set(contents)),
                    "arg_entropy": round(entropy_of_args(args), 3),
                },
                confidence=0.8,
            )
        ]
    return []


# ── User / safety / content ───────────────────────────────────────


def detect_user_frustration(view: TrajectoryView) -> list[dict[str, Any]]:
    for i, text in enumerate(view.user_messages):
        if i == 0:
            continue  # initial ask isn't frustration
        if FRUSTRATION_RE.search(text or ""):
            return [
                _result(
                    DescriptorId.USER_FRUSTRATION.value,
                    rationale="Later user turn expresses frustration or repeated correction",
                    evidence={"excerpt": (text or "")[:200]},
                    confidence=0.9,
                )
            ]
    return []


def detect_contradiction(view: TrajectoryView) -> list[dict[str, Any]]:
    """Assistant asserts opposite claims across turns (simple negation pairs)."""
    if len(view.assistant_messages) < 2:
        return []
    texts = [normalize_text(t) for t in view.assistant_messages if t]
    # Look for "X is open" then "X is closed" style via polarity words
    polar = [
        (
            bool(re.search(r"\b(open|available|success|succeeded|completed)\b", t)),
            bool(re.search(r"\b(closed|unavailable|failed|unsuccessful)\b", t)),
        )
        for t in texts
    ]
    saw_pos = any(p and not n for p, n in polar)
    saw_neg = any(n and not p for p, n in polar)
    if saw_pos and saw_neg and view.tool_calls:
        return [
            _result(
                DescriptorId.CONTRADICTION.value,
                rationale="Assistant made conflicting success/failure claims across turns",
                evidence={"kind": "polarity_flip"},
                confidence=0.65,
            )
        ]
    return []


def detect_refusal_inappropriate(view: TrajectoryView) -> list[dict[str, Any]]:
    user = view.first_user_text or ""
    final = view.final_assistant_text or ""
    if not REFUSAL_RE.search(final):
        return []
    # Benign actionable request
    if (intent_keywords(user) or re.search(
        r"\b(weather|order|transfer|email|schedule|search)\b", user, re.I
    )) and not JAILBREAK_RE.search(user):
        return [
            _result(
                DescriptorId.REFUSAL_INAPPROPRIATE.value,
                rationale="Assistant refused a benign in-domain request",
                evidence={"user_excerpt": user[:200]},
                confidence=0.7,
            )
        ]
    return []


def detect_jailbreak(view: TrajectoryView) -> list[dict[str, Any]]:
    for text in view.user_messages:
        if JAILBREAK_RE.search(text or ""):
            return [
                _result(
                    DescriptorId.JAILBREAK_ATTEMPT.value,
                    rationale="User message matches known jailbreak / instruction-override patterns",
                    evidence={"excerpt": (text or "")[:200]},
                    confidence=0.9,
                )
            ]
    return []


def detect_pii_leak(view: TrajectoryView) -> list[dict[str, Any]]:
    final = view.final_assistant_text or ""
    if PII_RE.search(final):
        return [
            _result(
                DescriptorId.PII_LEAK_RISK.value,
                rationale="Final answer appears to contain SSN/card-like PII patterns",
                evidence={},
                confidence=0.75,
            )
        ]
    return []


# ── Registry ──────────────────────────────────────────────────────

Detector = Callable[..., list[dict[str, Any]]]

ALL_DETECTORS: tuple[Detector, ...] = (
    detect_bad_tool_args,
    detect_tool_errors,
    detect_empty_tool_result,
    detect_mcp_auth,
    detect_error_swallow,
    detect_timeout,
    detect_loops,
    *LONG_AGENT_DETECTORS,
    detect_confusion_loop,
    detect_excessive_clarification,
    detect_excessive_steps,
    detect_cost_spike,
    detect_result_ignore,
    detect_output_fabrication,
    detect_inaccuracy,
    detect_stale_tool_result,
    detect_unnecessary_tool_call,
    detect_tool_skip,
    detect_wrong_tool,
    detect_extra_tool_call,
    detect_action_incomplete,
    detect_dead_end,
    detect_plan_drift,
    detect_no_progress,
    detect_user_frustration,
    detect_contradiction,
    detect_refusal_inappropriate,
    detect_jailbreak,
    detect_pii_leak,
)
