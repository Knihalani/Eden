"""Normalize telemetry event lists into a trajectory view for graders."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any


_FAILURE_OUTCOMES = frozenset(
    {"failure", "error", "timeout", "crash", "failed", "cancelled", "canceled"}
)

# Tokens that are too common to use for result-ignore matching.
_STOP_SALIENT = frozenset(
    {
        "true",
        "false",
        "null",
        "none",
        "status",
        "error",
        "message",
        "result",
        "data",
        "ok",
        "success",
        "failed",
        "failure",
        "type",
        "name",
        "value",
        "count",
        "total",
        "items",
        "id",
        "ids",
        "user",
        "tool",
        "call",
        "content",
        "role",
        "assistant",
        "system",
        "function",
        "arguments",
        "http",
        "https",
        "json",
        "text",
        "unknown",
    }
)

_SALIENT_RE = re.compile(
    r"""
    (?:
        [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}  # uuid
      | [A-Z]{2,}_[A-Z0-9_]{3,}                                         # CONST_ID
      | (?:acc_|ord_|txn_|user_|sess_|trace_|span_|call_)[A-Za-z0-9_-]{3,}
      | \$?\d+(?:\.\d+)?                                                # numbers / money
      | [A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}                  # email
      | [A-Za-z][A-Za-z0-9_-]{5,}                                       # long tokens
    )
    """,
    re.VERBOSE | re.IGNORECASE,
)


def _s(v: Any) -> str:
    if v is None:
        return ""
    return str(v).strip()


def _as_dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def parse_jsonish(raw: Any) -> Any:
    """Parse JSON string or return already-structured value."""
    if isinstance(raw, (dict, list)):
        return raw
    if not isinstance(raw, str):
        return raw
    text = raw.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return raw


def tool_name_from_call(tc: dict[str, Any]) -> str:
    if not isinstance(tc, dict):
        return ""
    if tc.get("name"):
        return _s(tc["name"])
    fn = tc.get("function")
    if isinstance(fn, dict) and fn.get("name"):
        return _s(fn["name"])
    return ""


def tool_args_from_call(tc: dict[str, Any]) -> Any:
    if not isinstance(tc, dict):
        return None
    if "arguments" in tc:
        return parse_jsonish(tc.get("arguments"))
    fn = tc.get("function")
    if isinstance(fn, dict) and "arguments" in fn:
        return parse_jsonish(fn.get("arguments"))
    if "args" in tc:
        return parse_jsonish(tc.get("args"))
    return None


def canonical_args(args: Any) -> str:
    """Stable string for loop hashing (sorted JSON when possible)."""
    if args is None:
        return ""
    if isinstance(args, str):
        parsed = parse_jsonish(args)
        if parsed is not args:
            args = parsed
        else:
            return args.strip()
    try:
        return json.dumps(args, sort_keys=True, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        return _s(args)


def extract_tool_calls_from_event(event: dict[str, Any]) -> list[dict[str, Any]]:
    """Collect tool-call dicts from common Eden event shapes.

    Prefer ``tool_calls_full`` when present; otherwise fall back to the
    OpenAI-style ``response_body.choices[].message.tool_calls``. Native
    ``tool.call`` spans only count as calls when they carry arguments
    (otherwise they are result/status spans and must not invent empty calls).
    """
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def _add(tc: dict[str, Any]) -> None:
        if not isinstance(tc, dict):
            return
        cid = _s(tc.get("id") or tc.get("tool_call_id"))
        name = tool_name_from_call(tc)
        # Dedup identical call ids; also skip nameless junk
        if not name:
            return
        if cid and cid in seen_ids:
            return
        if cid:
            seen_ids.add(cid)
        out.append(tc)

    full = event.get("tool_calls_full") or []
    if isinstance(full, list) and full:
        for tc in full:
            if isinstance(tc, dict):
                _add(tc)
        return out

    resp = event.get("response_body")
    if isinstance(resp, dict):
        choices = resp.get("choices") or []
        if isinstance(choices, list):
            for ch in choices:
                if not isinstance(ch, dict):
                    continue
                msg = ch.get("message") or {}
                if isinstance(msg, dict):
                    for tc in msg.get("tool_calls") or []:
                        if isinstance(tc, dict):
                            _add(tc)
        if out:
            return out

    # Native tool.call span — only if this looks like a call with args,
    # not a bare status/result event.
    et = _s(event.get("event_type")).lower()
    if "tool" in et:
        attrs = _as_dict(event.get("attributes"))
        name = _s(event.get("name")) or _s(attrs.get("tool_name")) or ""
        if not name or name in {"trace", "llm.fast", "llm.completion", "llm"}:
            return out
        args = attrs.get("tool_args")
        if args is None:
            req = event.get("request_body")
            if isinstance(req, dict) and (
                "arguments" in req or "args" in req or "parameters" in req
            ):
                args = req.get("arguments", req.get("args", req.get("parameters")))
            elif isinstance(req, dict) and req and not event.get("error"):
                # request_body present as arg object
                args = req
        # No arguments and we already have results/error → result span, skip
        if args is None and (event.get("tool_results") or event.get("error") or event.get("response_body")):
            return out
        if args is None and not attrs.get("tool_args"):
            return out
        _add({"name": name, "arguments": args, "span_id": event.get("span_id")})
    return out


def extract_tool_results_from_event(event: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for tr in event.get("tool_results") or []:
        if isinstance(tr, dict):
            out.append(tr)

    et = _s(event.get("event_type")).lower()
    if "tool" in et:
        content = event.get("response_body")
        if content is None:
            content = _as_dict(event.get("payload")).get("result")
        err = event.get("error")
        if content is not None or err:
            out.append(
                {
                    "tool_call_id": event.get("span_id"),
                    "content": content if not isinstance(content, dict) else json.dumps(content),
                    "error": err,
                    "outcome": event.get("outcome"),
                    "name": event.get("name"),
                }
            )
    return out


def assistant_texts(events: list[dict[str, Any]]) -> list[str]:
    texts: list[str] = []
    for e in events:
        resp = e.get("response_body")
        if isinstance(resp, dict):
            choices = resp.get("choices") or []
            if isinstance(choices, list):
                for ch in choices:
                    if not isinstance(ch, dict):
                        continue
                    msg = ch.get("message") or {}
                    if isinstance(msg, dict):
                        content = msg.get("content")
                        if isinstance(content, str) and content.strip():
                            texts.append(content)
        # Some fixtures put final text on payload.
        payload = e.get("payload")
        if isinstance(payload, dict):
            for k in ("final_answer", "output", "text", "content"):
                v = payload.get(k)
                if isinstance(v, str) and v.strip():
                    texts.append(v)
        if isinstance(e.get("reasoning"), str) and e["reasoning"].strip():
            # reasoning alone is not the user-facing answer; skip for result_ignore
            pass
    return texts


def user_texts(events: list[dict[str, Any]]) -> list[str]:
    texts: list[str] = []
    for e in events:
        req = e.get("request_body")
        if isinstance(req, dict):
            msgs = req.get("messages") or []
            if isinstance(msgs, list):
                for m in msgs:
                    if isinstance(m, dict) and m.get("role") == "user":
                        c = m.get("content")
                        if isinstance(c, str) and c.strip():
                            texts.append(c)
        attrs = _as_dict(e.get("attributes"))
        u = attrs.get("user_message") or attrs.get("input")
        if isinstance(u, str) and u.strip():
            texts.append(u)
    return texts


def extract_salient_tokens(text: str) -> set[str]:
    if not text:
        return set()
    found: set[str] = set()
    for m in _SALIENT_RE.finditer(text):
        tok = m.group(0)
        low = tok.lower().lstrip("$")
        if low in _STOP_SALIENT:
            continue
        if low.isdigit() and len(low) <= 2:
            continue
        # Prefer normalized form for matching.
        found.add(low)
        found.add(tok)
    return found


@dataclass
class NormalizedToolCall:
    name: str
    args: Any
    args_canonical: str
    call_id: str | None = None
    span_id: str | None = None
    event_index: int = 0
    schema_ok: bool | None = None
    parse_error: bool = False


@dataclass
class NormalizedToolResult:
    name: str | None
    content: str
    error: str | None
    outcome: str | None
    call_id: str | None = None
    event_index: int = 0


@dataclass
class TrajectoryView:
    """Flattened view of an agent trace for Layer A detectors."""

    events: list[dict[str, Any]]
    tool_calls: list[NormalizedToolCall] = field(default_factory=list)
    tool_results: list[NormalizedToolResult] = field(default_factory=list)
    user_messages: list[str] = field(default_factory=list)
    assistant_messages: list[str] = field(default_factory=list)
    tool_schemas: dict[str, dict[str, Any]] = field(default_factory=dict)
    expected_tools: list[str] = field(default_factory=list)
    max_tool_calls: int | None = None
    timeout_ms: float | None = None

    @property
    def final_assistant_text(self) -> str:
        return self.assistant_messages[-1] if self.assistant_messages else ""

    @property
    def all_assistant_text(self) -> str:
        return "\n".join(self.assistant_messages)

    @property
    def first_user_text(self) -> str:
        return self.user_messages[0] if self.user_messages else ""


def _collect_schemas(events: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    schemas: dict[str, dict[str, Any]] = {}
    for e in events:
        for source in (e.get("attributes"), e.get("payload"), e.get("request_body")):
            if not isinstance(source, dict):
                continue
            tools = source.get("tools") or source.get("tool_schemas") or source.get("functions")
            if isinstance(tools, str):
                tools = parse_jsonish(tools)
            if not isinstance(tools, list):
                continue
            for t in tools:
                if not isinstance(t, dict):
                    continue
                # OpenAI tools format
                if t.get("type") == "function" and isinstance(t.get("function"), dict):
                    fn = t["function"]
                    name = _s(fn.get("name"))
                    params = fn.get("parameters")
                    if name and isinstance(params, dict):
                        schemas[name] = params
                else:
                    name = _s(t.get("name"))
                    params = t.get("parameters") or t.get("input_schema") or t.get("schema")
                    if name and isinstance(params, dict):
                        schemas[name] = params
    return schemas


def _policy_from_events(events: list[dict[str, Any]]) -> tuple[list[str], int | None, float | None]:
    expected: list[str] = []
    max_calls: int | None = None
    timeout_ms: float | None = None
    for e in events:
        attrs = _as_dict(e.get("attributes"))
        pol = attrs.get("layer_a_policy") or attrs.get("eval_policy") or {}
        if isinstance(pol, str):
            pol = parse_jsonish(pol) or {}
        if not isinstance(pol, dict):
            continue
        et = pol.get("expected_tools") or pol.get("required_tools")
        if isinstance(et, list):
            expected = [str(x) for x in et]
        if pol.get("max_tool_calls") is not None:
            try:
                max_calls = int(pol["max_tool_calls"])
            except (TypeError, ValueError):
                pass
        if pol.get("timeout_ms") is not None:
            try:
                timeout_ms = float(pol["timeout_ms"])
            except (TypeError, ValueError):
                pass
    return expected, max_calls, timeout_ms


def build_trajectory(
    events: list[dict[str, Any]] | None,
    *,
    tool_schemas: dict[str, dict[str, Any]] | None = None,
    expected_tools: list[str] | None = None,
    max_tool_calls: int | None = None,
    timeout_ms: float | None = None,
) -> TrajectoryView:
    """Build a TrajectoryView from flat telemetry event dicts."""
    evs = [e for e in (events or []) if isinstance(e, dict)]
    schemas = dict(tool_schemas or {})
    schemas.update(_collect_schemas(evs))
    exp, mx, to = _policy_from_events(evs)
    if expected_tools:
        exp = list(expected_tools)
    if max_tool_calls is not None:
        mx = max_tool_calls
    if timeout_ms is not None:
        to = timeout_ms

    view = TrajectoryView(
        events=evs,
        user_messages=user_texts(evs),
        assistant_messages=assistant_texts(evs),
        tool_schemas=schemas,
        expected_tools=exp,
        max_tool_calls=mx,
        timeout_ms=to,
    )

    for i, e in enumerate(evs):
        for tc in extract_tool_calls_from_event(e):
            name = tool_name_from_call(tc)
            if not name:
                continue
            args = tool_args_from_call(tc)
            pe = False
            arg_src = tc.get("arguments")
            if arg_src is None and isinstance(tc.get("function"), dict):
                arg_src = tc["function"].get("arguments")
            if isinstance(arg_src, str) and arg_src.strip():
                try:
                    args = json.loads(arg_src)
                except json.JSONDecodeError:
                    pe = True
                    args = arg_src
            view.tool_calls.append(
                NormalizedToolCall(
                    name=name,
                    args=args,
                    args_canonical=canonical_args(args),
                    call_id=_s(tc.get("id") or tc.get("tool_call_id")) or None,
                    span_id=_s(tc.get("span_id") or e.get("span_id")) or None,
                    event_index=i,
                    parse_error=pe,
                )
            )

        for tr in extract_tool_results_from_event(e):
            content = tr.get("content")
            if content is not None and not isinstance(content, str):
                try:
                    content = json.dumps(content, default=str)
                except (TypeError, ValueError):
                    content = _s(content)
            nr = NormalizedToolResult(
                name=_s(tr.get("name")) or None,
                content=_s(content),
                error=_s(tr.get("error")) or None,
                outcome=_s(tr.get("outcome")) or None,
                call_id=_s(tr.get("tool_call_id")) or None,
                event_index=i,
            )
            # Dedup identical payloads from dual extraction paths
            if view.tool_results and view.tool_results[-1].content == nr.content and (
                view.tool_results[-1].error == nr.error
                and view.tool_results[-1].name == nr.name
                and view.tool_results[-1].event_index == nr.event_index
            ):
                continue
            view.tool_results.append(nr)

        # Tool failure signals without structured results
        outcome = _s(e.get("outcome")).lower()
        err = e.get("error")
        et = _s(e.get("event_type")).lower()
        is_toolish = "tool" in et or bool(e.get("tool_calls_full")) or bool(e.get("tool_results"))
        if is_toolish and (err or outcome in _FAILURE_OUTCOMES):
            # Ensure a result entry exists for tool_error detector
            name = (
                _s(e.get("name"))
                or _s(_as_dict(e.get("attributes")).get("tool_name"))
                or (view.tool_calls[-1].name if view.tool_calls else "unknown")
            )
            already = any(
                r.event_index == i and (r.error or (r.outcome or "").lower() in _FAILURE_OUTCOMES)
                for r in view.tool_results
            )
            if not already:
                view.tool_results.append(
                    NormalizedToolResult(
                        name=name,
                        content="",
                        error=_s(err) or outcome or "tool_error",
                        outcome=outcome or "failure",
                        call_id=_s(e.get("span_id")) or None,
                        event_index=i,
                    )
                )

    return view


def is_failure_outcome(outcome: str | None) -> bool:
    return _s(outcome).lower() in _FAILURE_OUTCOMES
