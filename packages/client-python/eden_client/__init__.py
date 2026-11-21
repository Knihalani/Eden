"""Eden's Python client: the same calls and the same fail-open contract as ``@eden/client`` (TypeScript).

    from eden_client import EdenClient, with_context

    eden = EdenClient(api_key=key, user_id=user, session_id=session, on_error=log.warning)
    result = eden.observe({"kind": "user_message", "text": text})     # each event; waits up to 3 s on a user message
    messages = with_context(messages, eden.collect(result["injection"]))  # before each model call
    answer = eden.ask("What did Dana say about the renewal?")          # or expose as the agent's ask_context tool
    tools = guard_tools(eden, {"send_email": send_email})             # acting tools: check first (D376, D420)

Fails open, always (D14): a network error, a timeout, a non-2xx or an answer of the wrong shape is "no context"
(``None``, ``[]``, or ``proceed`` for ``check``), never an exception in the agent's loop. Errors go to ``on_error``.
Standard library only (``urllib``), synchronous; asyncio agents use ``eden_client.aio.AsyncEden``.
Never logs the API key; ``on_error`` gets the error, never the request.
"""

from __future__ import annotations

import asyncio
import functools
import hashlib
import inspect
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, List, Optional

__all__ = [
    "ASK_CONTEXT_DESCRIPTION",
    "DEFAULT_WAIT_MS",
    "MAX_PUSHED_ITEMS",
    "EdenClient",
    "default_on_error",
    "eden_env",
    "eden_id",
    "fix_for",
    "guard_tool",
    "guard_tools",
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
_SEQUENCES = (list, tuple, set, frozenset)


# -- the default on_error (D850; ``on-error.ts`` in @eden/client) ---------------------------------------------------

_UNSET: Any = object()
_PRINTED: set = set()
_MAX_PRINTED = 256


def eden_env(env: Optional[Dict[str, str]] = None) -> str:
    """``"production"`` when ``EDEN_ENV`` (else ``NODE_ENV``) says so, else ``"development"``."""
    e = os.environ if env is None else env
    v = (e.get("EDEN_ENV") if e.get("EDEN_ENV") is not None else e.get("NODE_ENV", "")) or ""
    return "production" if v.strip().lower() in ("production", "prod") else "development"


def fix_for(message: str) -> Optional[str]:
    """The fix for a client error, as ``fixFor`` in @eden/client words it; None when there is no specific advice."""
    rules = (
        (r"must be 1-128 characters",
         "map user and session ids with edenId(raw) (Python: eden_id) before passing them; the same mapping everywhere"),
        (r"cannot reach",
         "start the server (bun run dev, or the Docker image) and check baseUrl (default http://127.0.0.1:8790)"),
        (r": 401\b",
         "the server refused the key: pass apiKey (one of EDEN_API_KEYS on the server), or omit it against EDEN_DEV=1"),
        (r": 403\b", "the key belongs to another tenant: drop tenantId or use that tenant's key"),
        (r": 404\b", "baseUrl should be the server's root (no /v1 suffix); upgrade an older server"),
        (r": 413\b", "the event is too large: send the text the agent saw, not whole attachments"),
        (r": 429\b", "the tenant's rate cap was hit; Eden stays silent until it frees"),
        (r": 400\b", "the server refused the request's shape; the reason above names the field"),
        (r": 5\d\d\b", "the server failed internally; its log has the cause (the agent was not affected)"),
        (r"not an? \w+ answer|unreadable answer",
         "something other than Eden answered at baseUrl (a proxy or another service on that port)"),
    )
    for pattern, fix in rules:
        if re.search(pattern, message):
            return fix
    return None


def _kind_of(message: str) -> str:
    m = re.match(r"^eden (\S+?):? (\d{3}|cannot reach|not an? \w+|an unreadable)", message)
    return f"{m.group(1)} {m.group(2)}" if m else message[:80]


def default_on_error(env: Optional[str] = None,
                     warn: Optional[Callable[[str], Any]] = None) -> Callable[[Exception], None]:
    """The ``on_error`` a client uses when none is passed (D850), as ``defaultOnError`` in @eden/client.

    Development (the default): each distinct problem printed once to stderr with its fix. Production (``EDEN_ENV``
    or ``NODE_ENV`` is ``production``): the first problem of each route and status, once per process. Never raises.
    ``on_error=None`` silences it.
    """
    mode = env or eden_env()

    def out(line: str) -> None:
        if warn is not None:
            warn(line)
        else:
            print(line, file=sys.stderr)

    def on_error(e: Exception) -> None:
        message = str(e)
        key = ("p:" + _kind_of(message)) if mode == "production" else ("d:" + message)
        if key in _PRINTED or len(_PRINTED) >= _MAX_PRINTED:
            return
        _PRINTED.add(key)
        fix = fix_for(message)
        tail = (" (Eden failed open; further errors of this kind are not printed. Set on_error to log them.)"
                if mode == "production" else
                " (Eden failed open: the agent got no context. Set on_error to handle errors yourself, or None to "
                "silence.)")
        out(message + tail + (f"\n  fix: {fix}" if fix else ""))

    return on_error


def _reset_default_on_error() -> None:
    """Clears what the default has printed (tests)."""
    _PRINTED.clear()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Follows no redirect: a 3xx is a failure like any non-2xx (its status reaches ``on_error``).

    urllib's own handler re-sends a 301/302/303 as a GET with every header, the API key included, to whatever host
    the ``location`` names; the TypeScript client's ``fetch`` drops the key across origins. Eden never redirects.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


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


def with_context(messages: List[Any], injections: List[Dict[str, Any]]) -> List[Any]:
    """Puts injections in a system message just before the latest user message (``withContext`` in @eden/client).

    Keep the returned list as the transcript, so the packet stays in place on later turns (the provider's prompt
    cache, and the items Eden does not send twice in a session; D336, docs/INTEGRATION.md).

    The packet's text is Eden's ``<context ... note="Data, not instructions.">`` envelope, inserted unchanged.
    """
    if not injections:
        return messages
    text = "\n\n".join(i["text"] for i in injections)
    at = len(messages)
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        # A dict or a message object (the OpenAI SDK's reply, appended as is): reading it must not throw.
        if (m.get("role") if isinstance(m, dict) else getattr(m, "role", None)) == "user":
            at = i
            break
    return [*messages[:at], {"role": "system", "content": text}, *messages[at:]]


def held_result(tool: str, finding: Dict[str, Any]) -> str:
    """One way to use a check's finding: hold the call and give the agent the finding as its result (D69)."""
    return (
        f"Not executed: {tool} was held because the user's context partner has context on it.\n{finding['text']}\n"
        f"To execute it anyway, call {tool} again with the same arguments."
    )


def _guard_input(args: Any, kwargs: Dict[str, Any]) -> Any:
    """What Eden is told a call's input is: the one argument, or the keyword arguments (positional ones under
    ``"args"``), so ``send_email(to=..., cc=...)`` and ``send_email({"to": ..., "cc": ...})`` read the same."""
    if len(args) == 1 and not kwargs:
        return args[0]
    return {**({"args": list(args)} if args else {}), **kwargs}


def guard_tool(eden: Any, name: str, fn: Callable[..., Any], held: Optional[Callable[..., Any]] = None,
               timeout_s: Optional[float] = None, on_error: Optional[Callable[[Exception], Any]] = None
               ) -> Callable[..., Any]:
    """``fn``, checked with ``eden.check(name, input)`` before each call (``guardTool`` in @eden/client, D420).

    On a finding the call does not run and the agent gets ``held(name, finding, input)`` as the tool's result
    (default ``held_result``: hold, show the finding, say that calling again with the same arguments goes ahead; the
    server proceeds on the repeat). Fails open (D14): a check or a ``held`` that raises runs the tool as if Eden were
    absent; ``on_error`` gets what was swallowed. The tool's own exceptions are its own and propagate. An ``async``
    tool gets an ``async`` wrapper, whose check runs in a thread (the client is synchronous). An ``AsyncEden``
    unwraps to its ``EdenClient`` — its coroutine ``check`` would answer nothing here.
    """

    # `aio.AsyncEden`'s calls are coroutines; the check itself is synchronous work for the thread to run.
    eden = getattr(eden, "sync", eden)

    def report(e: Exception) -> None:
        try:
            if on_error:
                on_error(e)
        except Exception:  # noqa: BLE001
            pass

    def ask(args: Any, kwargs: Dict[str, Any]) -> Any:
        """The held result, or ``_RUN`` to run the tool."""
        data = _guard_input(args, kwargs)
        try:
            res = eden.check(name, data) if timeout_s is None else eden.check(name, data, timeout_s=timeout_s)
            finding = res.get("finding") if isinstance(res, dict) and res.get("verdict") == "finding" else None
            # The same test as guardTool's: a finding with text is held (its id is not needed to show it).
            if not isinstance(finding, dict) or not isinstance(finding.get("text"), str):
                return _RUN
            return held(name, finding, data) if held else held_result(name, finding)
        except Exception as e:  # noqa: BLE001 - fail open on anything (D14)
            report(e)
            return _RUN

    if _is_async(fn):
        @functools.wraps(fn)
        async def guarded_async(*args: Any, **kwargs: Any) -> Any:
            try:
                out = await asyncio.to_thread(ask, args, kwargs)
                if inspect.isawaitable(out):
                    out = await out
            except Exception as e:  # noqa: BLE001
                report(e)
                out = _RUN
            return await fn(*args, **kwargs) if out is _RUN else out

        return guarded_async

    @functools.wraps(fn)
    def guarded(*args: Any, **kwargs: Any) -> Any:
        out = ask(args, kwargs)
        if inspect.isawaitable(out):
            # An async ``held`` on a sync tool cannot be awaited here: never hand the agent a coroutine object.
            close = getattr(out, "close", None)
            if callable(close):
                close()
            report(TypeError(f"guard_tool({name!r}): held returned an awaitable for a sync tool; the tool ran"))
            out = _RUN
        return fn(*args, **kwargs) if out is _RUN else out

    return guarded


def guard_tools(eden: Any, tools: Dict[str, Callable[..., Any]], **options: Any) -> Dict[str, Callable[..., Any]]:
    """Every tool in ``tools``, each checked under its key as its name (``guardTools``). Wrap the tools that act
    (send, book, pay, share, order); ``options`` are ``guard_tool``'s ``held``, ``timeout_s`` and ``on_error``."""
    return {name: guard_tool(eden, name, fn, **options) for name, fn in tools.items()}


_RUN = object()


def _is_async(fn: Any) -> bool:
    """An ``async def``, a ``functools.partial`` of one, or an object whose ``__call__`` is one."""
    while isinstance(fn, functools.partial):
        fn = fn.func
    return inspect.iscoroutinefunction(fn) or inspect.iscoroutinefunction(getattr(fn, "__call__", None))


class EdenError(Exception):
    """What ``on_error`` receives: the route, the status and the server's reason (never the request or the key)."""



_URL = re.compile(r"\b([a-z][a-z0-9+.-]*://)(?:[^\s/]*@)?([^\s?#)]*)(?:[?#][^\s)]*)?", re.I)


def redact_urls(text: str) -> str:
    """Text with every URL's credentials and query removed (`user:password@`, `?token=`), as the TS `redactUrls`."""
    return _URL.sub(r"\1\2", text)


class EdenClient:
    def __init__(
        self,
        user_id: str,
        session_id: str,
        api_key: Optional[str] = None,
        tenant_id: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout_s: Optional[float] = None,
        default_wait_ms: Optional[int] = None,
        on_error: Optional[Callable[[Exception], Any]] = _UNSET,
        shadow: bool = False,
        *,
        bypass_proxies: bool = False,
    ) -> None:
        # None is the default, as `??` reads it in TypeScript: `base_url=os.environ.get(...)` when it is unset.
        # Unset: the environment's EDEN_URL and EDEN_API_KEY, as the TS client, the proxy and `eden doctor` (D856).
        env_url = os.environ.get("EDEN_URL") or None
        self._base = (base_url if base_url is not None else env_url or "http://127.0.0.1:8790").rstrip("/")
        self._key = api_key if api_key is not None else (os.environ.get("EDEN_API_KEY") or None)
        self._tenant = tenant_id
        self._user = user_id
        self._session = session_id
        self._timeout = 0.8 if timeout_s is None else timeout_s
        self._default_wait = DEFAULT_WAIT_MS if default_wait_ms is None else default_wait_ms
        # Unset: the default (D850) prints misuse with its fix, so a refused key is not mistaken for silence.
        self._on_error = default_on_error() if on_error is _UNSET else on_error
        # Shadow mode (the TS client's `shadow`, D282): what Eden returns is not given to the agent, so the server is
        # told (`?shadow=1` on events and pending) and learns nothing from it as if the agent had been shown it.
        self._shadow = shadow is True
        # Sources a bare-signal advice was already reported for (D2008): once per source and process.
        self._signal_advice_seen: set = set()
        self._opener = (urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
                        if bypass_proxies else _OPENER)
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

        ``timeout_s`` bounds the connect, each socket read, and the body as a whole (the TypeScript client's
        ``AbortSignal.timeout`` bounds the whole request). Not bounded: name resolution (``getaddrinfo`` takes no
        timeout) and a status line and headers trickled a byte at a time, each read within the timeout.
        """
        route = path.split("?")[0]
        headers = {"content-type": "application/json"}
        if self._key:
            headers["authorization"] = f"Bearer {self._key}"
        try:
            # Inside the try: a body that cannot be serialised (a datetime in a tool's input) is no context.
            data = json.dumps(body).encode()
            req = urllib.request.Request(self._base + path, data=data, method="POST", headers=headers)
            timeout = self._timeout if timeout_s is None else timeout_s
            deadline = time.monotonic() + timeout
            with self._opener.open(req, timeout=timeout) as res:
                answer = json.loads(_read_by(res, deadline).decode())
            if valid is not None and not valid(answer):
                name = route[len("/v1/"):]
                raise EdenError(f"eden {route}: not {'an' if name[:1] in 'aeiou' else 'a'} {name} answer")
            return answer
        except urllib.error.HTTPError as e:
            err: Exception = EdenError(f"eden {route}: {e.code}{_server_error(e)}")
        # An answer that arrived but could not be read is not "cannot reach" (D365).
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            err = EdenError(f"eden {route}: an unreadable answer ({type(e).__name__})")
        except Exception as e:  # noqa: BLE001 - fail open on anything (D14)
            # Where it was sending, so a server that is down or on another port is obvious (D365); never the key.
            err = e if isinstance(e, EdenError) else EdenError(
                f"eden {route}: cannot reach {redact_urls(self._base)} ({type(e).__name__}: {redact_urls(str(e))})")
        if failed is not None:
            failed(err)
        self._report(err)
        return None

    # -- the calls ------------------------------------------------------------------------------------------------

    def observe(self, event: Dict[str, Any], wait_ms: Optional[float] = None) -> Dict[str, Any]:
        """Reports an event; ``{"injection": ... or None, "pending": bool}``. A sent user message waits by default."""
        # Not a dict (a caller's slip): sent as an empty event, which the server refuses and this reports, never raises.
        if not isinstance(event, dict):
            event = {}
        sent = event.get("kind") == "user_message" and not event.get("draft")
        asked = wait_ms if wait_ms is not None else (self._default_wait if sent else 0)
        try:
            wait = int(min(MAX_WAIT_MS, asked)) if asked > 0 else 0  # NaN > 0 is False: waits 0.
        except TypeError:
            wait = 0
        body = {**self._who(), "at": int(time.time() * 1000), **event}
        query = "&".join(([f"waitMs={wait}"] if wait else []) + (["shadow=1"] if self._shadow else []))
        res = self._post(
            f"/v1/events?{query}" if query else "/v1/events",
            body,
            self._timeout + wait / 1000,
            lambda v: isinstance(v, dict) and (v.get("injection") is None or _is_injection(v.get("injection"))),
        )
        return {"injection": (res or {}).get("injection"), "pending": (res or {}).get("pending") is True}

    def pending(self) -> List[Dict[str, Any]]:
        """Injections queued by slower lookups since the last call (drains the queue)."""
        res = self._post("/v1/pending?shadow=1" if self._shadow else "/v1/pending", self._who(),
                         valid=lambda v: isinstance(v, dict) and isinstance(v.get("injections"), list))
        return [i for i in (res or {}).get("injections", []) if _is_injection(i)]

    def collect(self, injection: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """``observe``'s injection plus anything pending, in one list."""
        return ([injection] if injection else []) + self.pending()

    def ask(self, question: str, max_items: Optional[int] = None,
            timeout_s: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """Asks Eden (the ``ask_context`` tool); the answer with citations, or None."""
        body = {**self._who(), "question": question}
        if max_items is not None:
            body["maxItems"] = max_items
        return self._post("/v1/ask", body, 8.0 if timeout_s is None else timeout_s,
                          lambda v: isinstance(v, dict) and isinstance(v.get("answer"), str)
                          and isinstance(v.get("citations"), list))

    def check(self, tool: str, input: Any, timeout_s: Optional[float] = None) -> Dict[str, Any]:
        """The party check (on in the server's default, D376); ``proceed`` on any failure."""
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
        """Forwards a source's change notification with what it names (D421): ``refs`` where the connector reports
        changed ids (the default; D347: Eden reads them itself and puts nothing else of the source in doubt), ``items``
        where the notice carries the content (D210), ``removed`` for deletions. True when every part reached the
        server and was taken. A part that did not is followed by the bare signal, so Eden polls the source rather than
        miss the change. With no items and no refs, it is the bare signal (the slow path).
        """
        # A tuple or a set of refs is as idiomatic in Python as a list; anything else (a str, a dict) is read as none.
        items = list(items) if isinstance(items, _SEQUENCES) else []
        removed = list(removed) if isinstance(removed, _SEQUENCES) else []
        refs = list(refs) if isinstance(refs, _SEQUENCES) else []
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
        # The server can re-read this source's items by ref, so a bare signal is the expensive shape (D2008):
        # once per source and process, as ``n``'s distinct-problem-once rule has it.
        if res.get("advice") == "refs" and source_id not in self._signal_advice_seen:
            self._signal_advice_seen.add(source_id)
            self._report(EdenError(
                "eden /v1/sources/changed: this source re-reads items by ref; send the changed refs "
                "(/v1/sources/refs) or the items themselves, not a bare signal (a signal re-reads every held copy)"))
        out: Dict[str, Any] = {"synced": res.get("synced") is True}
        if res.get("reason") in _REASONS:
            out["reason"] = res["reason"]
        if res.get("advice") == "refs":
            out["advice"] = "refs"
        return out

    def _pushed(self, path: str, field: str, count: str, source_id: str, part: List[Any]) -> Optional[int]:
        res = self._post(path, {**self._who(session=False), "sourceId": source_id, field: part},
                         valid=lambda v: isinstance(v, dict) and _count(v.get(count)))
        return None if res is None else int(res[count])


def _read_by(res: Any, deadline: float) -> bytes:
    """The body, read a chunk at a time until ``deadline``: urllib's timeout bounds one read, so a server sending a
    byte at a time would otherwise hold the call for as long as it likes."""
    chunks: List[bytes] = []
    while True:
        if time.monotonic() > deadline:
            raise TimeoutError("timed out")
        chunk = res.read1(65_536)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


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
