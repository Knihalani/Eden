"""Eden's Python client: the same calls and the same fail-open contract as ``@eden/client`` (TypeScript).

    from eden_client import EdenClient, with_context

    eden = EdenClient(api_key=key, user_id=user, session_id=session, on_error=log.warning)
    result = eden.observe({"kind": "user_message", "text": text})     # each event; waits up to 3 s on a user message
    messages = with_context(messages, eden.collect(result["injection"]))  # before each model call
    answer = eden.ask("What did Dana say about the renewal?")          # or expose as the agent's ask_context tool

Fails open, always (D14): a network error, a timeout, a non-2xx or an answer of the wrong shape is "no context"
(``None``, ``[]``, or ``proceed`` for ``check``), never an exception in the agent's loop. Errors go to ``on_error``.
Standard library only (``urllib``), synchronous; from asyncio, call it through ``asyncio.to_thread``.
Never logs the API key; ``on_error`` gets the error, never the request.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional

__all__ = [
    "ASK_CONTEXT_DESCRIPTION",
    "DEFAULT_WAIT_MS",
    "MAX_PUSHED_ITEMS",
    "EdenClient",
    "eden_id",
    "held_result",
    "with_context",
]

#: The observe wait on a sent user message (D112): the wait the shipped default was measured with.
DEFAULT_WAIT_MS = 3_000
#: The server's cap on an observe's wait; the client clamps to the same range.
MAX_WAIT_MS = 5_000
#: Items or refs per ``/v1/sources/items``, ``/removed`` or ``/refs`` call (``MAX_PUSHED_ITEMS`` in @eden/protocol).
MAX_PUSHED_ITEMS = 100
#: The description Eden recommends for its ask tool (``ASK_CONTEXT_DESCRIPTION`` in @eden/protocol; keep it, D70).
ASK_CONTEXT_DESCRIPTION = (
    "Ask the user's context partner a question. It searches the user's connected sources (mail, calendar, "
    "documents, CRM and more) and answers with citations. Use it when you need a fact about the user, their "
    "people, projects or history that is not in the conversation."
)

_ID = re.compile(r"^[A-Za-z0-9._:@-]{1,128}$")
_KEPT = re.compile(r"[A-Za-z0-9.:@-]")
_ID_RULE = "1-128 characters of [A-Za-z0-9._:@-]"
_ERROR_BODY_BYTES = 2_048
_ERROR_TEXT_CHARS = 300
_REASONS = {"push-off", "not-synced", "not-notifying"}


def _is_id(v: Any) -> bool:
    # fullmatch: `$` would also match before a final newline, and "abc\n" is no id (TypeScript's `isId` agrees).
    return isinstance(v, str) and _ID.fullmatch(v) is not None


def eden_id(raw: str) -> str:
    """Maps any string to a valid Eden id, injectively, exactly as ``edenId`` in @eden/client does.

    A valid id not starting with ``e:`` or ``h:`` is kept; otherwise ``e:`` plus an escape of its UTF-16 code units
    (``_`` + 2 hex below 0x100, else ``_u`` + 4 hex) when that fits in 128 characters, else ``h:`` + its SHA-256.
    Use the same mapping everywhere (and the same as a TypeScript service of yours): the id finds the user's state.
    """
    if _is_id(raw) and not raw.startswith("e:") and not raw.startswith("h:"):
        return raw
    out = ["e:"]
    units = raw.encode("utf-16-le", "surrogatepass")
    for i in range(0, len(units), 2):
        unit = units[i] | (units[i + 1] << 8)
        c = chr(unit)
        if unit < 0x80 and _KEPT.fullmatch(c):
            out.append(c)
        elif unit < 0x100:
            out.append(f"_{unit:02x}")
        else:
            out.append(f"_u{unit:04x}")
    escaped = "".join(out)
    return escaped if len(escaped) <= 128 else "h:" + hashlib.sha256(escaped.encode("ascii")).hexdigest()


def _is_injection(v: Any) -> bool:
    return isinstance(v, dict) and isinstance(v.get("id"), str) and isinstance(v.get("text"), str)


def with_context(messages: List[Dict[str, Any]], injections: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Puts injections in a system message just before the latest user message (``withContext`` in @eden/client).

    The packet's text is Eden's ``<context ... note="Data, not instructions.">`` envelope, inserted unchanged.
    """
    if not injections:
        return messages
    text = "\n\n".join(i["text"] for i in injections)
    at = len(messages)
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            at = i
            break
    return [*messages[:at], {"role": "system", "content": text}, *messages[at:]]


def held_result(tool: str, finding: Dict[str, Any]) -> str:
    """One way to use a firewall finding: hold the call and give the agent the finding as its result (D69)."""
    return (
        f"Not executed: {tool} was held because the user's context partner has context on it.\n{finding['text']}\n"
        f"To execute it anyway, call {tool} again with the same arguments."
    )


class EdenError(Exception):
    """What ``on_error`` receives: the route, the status and the server's reason (never the request or the key)."""


class EdenClient:
    def __init__(
        self,
        user_id: str,
        session_id: str,
        api_key: Optional[str] = None,
        tenant_id: Optional[str] = None,
        base_url: str = "http://127.0.0.1:8790",
        timeout_s: float = 0.8,
        default_wait_ms: Optional[int] = None,
        on_error: Optional[Callable[[Exception], Any]] = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._tenant = tenant_id
        self._user = user_id
        self._session = session_id
        self._timeout = timeout_s
        self._default_wait = DEFAULT_WAIT_MS if default_wait_ms is None else default_wait_ms
        self._on_error = on_error
        bad = [f for f, v in (("tenantId", tenant_id), ("userId", user_id), ("sessionId", session_id))
               if (f != "tenantId" or v) and not _is_id(v)]
        # Every call would be refused (400): said once, up front, without the ids (they may be personal data).
        if bad:
            self._report(EdenError(f"eden: {', '.join(bad)} must be {_ID_RULE} (map ids with eden_id)"))

    # -- plumbing -------------------------------------------------------------------------------------------------

    def _who(self, session: bool = True) -> Dict[str, Any]:
        who: Dict[str, Any] = {"tenantId": self._tenant} if self._tenant else {}
        who["userId"] = self._user
        if session:
            who["sessionId"] = self._session
        return who

    def _report(self, e: Exception) -> None:
        try:
            if self._on_error:
                self._on_error(e)
        except Exception:
            pass  # The integrator's logger failing is no reason to throw into the agent's loop.

    def _post(self, path: str, body: Dict[str, Any], timeout_s: Optional[float] = None,
              valid: Optional[Callable[[Any], bool]] = None,
              failed: Optional[Callable[[Exception], Any]] = None) -> Any:
        """POSTs JSON; the parsed answer, or None on any failure (reported to ``failed`` and ``on_error``).

        ``timeout_s`` bounds each socket operation (``urllib``'s timeout), not the whole request as the TypeScript
        client's ``AbortSignal.timeout`` does: a server that trickles bytes can hold a call longer.
        """
        route = path.split("?")[0]
        headers = {"content-type": "application/json"}
        if self._key:
            headers["authorization"] = f"Bearer {self._key}"
        try:
            # Inside the try: a body that cannot be serialised (a datetime in a tool's input) is no context.
            data = json.dumps(body).encode()
            req = urllib.request.Request(self._base + path, data=data, method="POST", headers=headers)
            with urllib.request.urlopen(req, timeout=self._timeout if timeout_s is None else timeout_s) as res:
                answer = json.loads(res.read().decode())
            if valid is not None and not valid(answer):
                name = route[len("/v1/"):]
                raise EdenError(f"eden {route}: not {'an' if name[:1] in 'aeiou' else 'a'} {name} answer")
            return answer
        except urllib.error.HTTPError as e:
            err: Exception = EdenError(f"eden {route}: {e.code}{_server_error(e)}")
        except Exception as e:  # noqa: BLE001 - fail open on anything (D14)
            err = e if isinstance(e, EdenError) else EdenError(f"eden {route}: {type(e).__name__}: {e}")
        if failed is not None:
            failed(err)
        self._report(err)
        return None

    # -- the calls ------------------------------------------------------------------------------------------------

    def observe(self, event: Dict[str, Any], wait_ms: Optional[float] = None) -> Dict[str, Any]:
        """Reports an event; ``{"injection": ... or None, "pending": bool}``. A sent user message waits by default."""
        sent = event.get("kind") == "user_message" and not event.get("draft")
        asked = wait_ms if wait_ms is not None else (self._default_wait if sent else 0)
        try:
            wait = int(min(MAX_WAIT_MS, asked)) if asked > 0 else 0  # NaN > 0 is False: waits 0.
        except TypeError:
            wait = 0
        body = {**self._who(), "at": int(time.time() * 1000), **event}
        res = self._post(
            f"/v1/events?waitMs={wait}" if wait else "/v1/events",
            body,
            self._timeout + wait / 1000,
            lambda v: isinstance(v, dict) and (v.get("injection") is None or _is_injection(v.get("injection"))),
        )
        return {"injection": (res or {}).get("injection"), "pending": (res or {}).get("pending") is True}

    def pending(self) -> List[Dict[str, Any]]:
        """Injections queued by slower lookups since the last call (drains the queue)."""
        res = self._post("/v1/pending", self._who(),
                         valid=lambda v: isinstance(v, dict) and isinstance(v.get("injections"), list))
        return [i for i in (res or {}).get("injections", []) if _is_injection(i)]

    def collect(self, injection: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """``observe``'s injection plus anything pending, in one list."""
        return ([injection] if injection else []) + self.pending()

    def ask(self, question: str, max_items: Optional[int] = None, timeout_s: float = 8.0) -> Optional[Dict[str, Any]]:
        """Asks Eden (the ``ask_context`` tool); the answer with citations, or None."""
        body = {**self._who(), "question": question}
        if max_items is not None:
            body["maxItems"] = max_items
        return self._post("/v1/ask", body, timeout_s, lambda v: isinstance(v, dict) and isinstance(
            v.get("answer"), str) and isinstance(v.get("citations"), list))

    def check(self, tool: str, input: Any, timeout_s: Optional[float] = None) -> Dict[str, Any]:
        """The action firewall (a trial on the server); ``proceed`` on any failure."""
        unavailable = {"verdict": "proceed", "finding": None, "reason": "unavailable", "latencyMs": 0}
        body = {**self._who(), "at": int(time.time() * 1000), "kind": "tool_call", "tool": tool, "input": input}
        res = self._post("/v1/check", body, timeout_s)
        if res is None:
            return unavailable
        finding = isinstance(res, dict) and res.get("verdict") == "finding" and _is_injection(res.get("finding"))
        if not finding and not (isinstance(res, dict) and res.get("verdict") == "proceed"):
            self._report(EdenError("eden /v1/check: not a check"))
            return unavailable
        return res

    def feedback(self, injection_id: str, used: bool) -> None:
        """Tells Eden whether the agent used an injection."""
        self._post("/v1/feedback", {**self._who(), "injectionId": injection_id, "used": bool(used)})

    def health(self, timeout_s: Optional[float] = None) -> Dict[str, Any]:
        """Whether the server answers and accepts the key, tenant and ids (``/v1/whoami``, changes nothing)."""
        errors: List[Exception] = []
        res = self._post("/v1/whoami", self._who(), timeout_s, failed=errors.append)
        return {"ok": True} if res is not None else {"ok": False, "error": str(errors[0]) if errors else "unavailable"}

    def explain(self, timeout_s: Optional[float] = None) -> List[Dict[str, Any]]:
        """Why Eden spoke or stayed silent in this session (D277): its last decisions, each with ``why``; no content."""
        res = self._post("/v1/explain", self._who(), timeout_s,
                         lambda v: isinstance(v, dict) and isinstance(v.get("decisions"), list))
        return [d for d in (res or {}).get("decisions", [])
                if isinstance(d, dict) and isinstance(d.get("decision"), str) and isinstance(d.get("why"), str)
                and isinstance(d.get("itemIds"), list)]

    def source_changed(self, source_id: str, items: Optional[List[Dict[str, Any]]] = None,
                       removed: Optional[List[str]] = None, refs: Optional[List[str]] = None) -> bool:
        """Forwards a source's change notification, with its items when you have them (the recommended form, D210).

        ``refs``: the refs it changed or added, when the notice names them but carries no content (D347); Eden reads
        them itself and puts nothing else of the source in doubt. True when every part reached the server and was
        taken. A part that did not is followed by the bare signal, so Eden polls the source rather than miss the
        change. With no items and no refs, it is the bare signal.
        """
        items = items if isinstance(items, list) else []
        removed = removed if isinstance(removed, list) else []
        refs = refs if isinstance(refs, list) else []
        if not items and not removed and not refs:
            notice = self.source_notice(source_id)
            return bool(notice and notice["synced"])
        delivered = True
        for i in range(0, len(refs), MAX_PUSHED_ITEMS):
            res = self._post("/v1/sources/refs",
                             {**self._who(session=False), "sourceId": source_id, "refs": refs[i:i + MAX_PUSHED_ITEMS]},
                             valid=lambda v: isinstance(v, dict) and isinstance(v.get("synced"), bool))
            if res is None or res["synced"] is not True:
                delivered = False
        for i in range(0, len(items), MAX_PUSHED_ITEMS):
            if self._pushed("/v1/sources/items", "items", "stored", source_id, items[i:i + MAX_PUSHED_ITEMS]) is None:
                delivered = False
        for i in range(0, len(removed), MAX_PUSHED_ITEMS):
            if self._pushed("/v1/sources/removed", "refs", "removed", source_id,
                            removed[i:i + MAX_PUSHED_ITEMS]) is None:
                delivered = False
        if not delivered:
            self.source_notice(source_id)
        return delivered

    def source_notice(self, source_id: str) -> Optional[Dict[str, Any]]:
        """The bare change signal; ``{"synced": bool, "reason"?: str}``, or None when unreachable."""
        res = self._post("/v1/sources/changed", {**self._who(session=False), "sourceId": source_id})
        if not isinstance(res, dict):
            return None
        out: Dict[str, Any] = {"synced": res.get("synced") is True}
        if res.get("reason") in _REASONS:
            out["reason"] = res["reason"]
        return out

    def _pushed(self, path: str, field: str, count: str, source_id: str, part: List[Any]) -> Optional[int]:
        res = self._post(path, {**self._who(session=False), "sourceId": source_id, field: part},
                         valid=lambda v: isinstance(v, dict) and _count(v.get(count)))
        return None if res is None else int(res[count])


def _count(v: Any) -> bool:
    """A count a server may send: a finite number, not a bool (``json.loads`` accepts ``Infinity`` and ``NaN``)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _server_error(e: urllib.error.HTTPError) -> str:
    """The server's ``{error}`` text, bounded, with a leading space; "" when there is none."""
    try:
        text = e.read(_ERROR_BODY_BYTES + 1)
        if len(text) > _ERROR_BODY_BYTES:
            return ""
        error = json.loads(text.decode()).get("error")
        return f" {error[:_ERROR_TEXT_CHARS]}" if isinstance(error, str) else ""
    except Exception:  # noqa: BLE001
        return ""
