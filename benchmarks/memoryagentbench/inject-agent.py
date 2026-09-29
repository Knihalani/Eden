"""MemoryAgentBench agent: product `openMemory` inject + NVIDIA NIM reader.

Memorize via bridge add/flush (`observe`). Query via inject packet + NIM
`google/gemma-4-31b-it`. k=10 always. No ICL k bump. No `label:` strip.

Overlay onto `/tmp/MemoryAgentBench/methods/eden.py` at runtime. The harness
imports `initialize_eden_agent` / `handle_eden_agent` when agent_name contains
`eden`.
"""

import json
import os
import re
import subprocess
import threading
import time

SENTINEL = "@@EDEN@@"

_QUERY_PATTERNS = [
    re.compile(r"Now Answer the Question:\s*(.*)", re.S),
    re.compile(r"Here is the conversation:\s*(.*)", re.S),
    re.compile(r"Question:\s*(.*?)(?:\n\s*label:|\Z)", re.S),
    re.compile(r"complete the task below:\s*(.*?)(?:\n\s*The event that happens next is:|\Z)", re.S | re.I),
]


def _load_eden_env():
    if os.environ.get("NVIDIA_API_KEY") and os.environ.get("NVIDIA_BASE_URL"):
        return
    root = os.environ.get("EDEN_ROOT")
    if not root:
        return
    path = os.path.join(root, ".env")
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            if key not in ("NVIDIA_API_KEY", "NVIDIA_BASE_URL", "NIM_MODEL"):
                continue
            if key not in os.environ or not os.environ.get(key):
                os.environ[key] = val.strip().strip('"').strip("'")


class EdenBridge:
    def __init__(self):
        bridge_path = os.environ.get("EDEN_BRIDGE")
        root = os.environ.get("EDEN_ROOT")
        if not bridge_path or not root:
            raise RuntimeError("Set EDEN_BRIDGE (inject-bridge.ts) and EDEN_ROOT (Eden checkout)")
        bun = os.environ.get("EDEN_BUN", "bun")
        env = os.environ.copy()
        env.setdefault("EDEN_MEMORY_CAP", "10")
        env.setdefault("EDEN_MEMORY_STORE_CAP", "50000")
        self.proc = subprocess.Popen(
            [bun, bridge_path],
            cwd=root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            env=env,
        )
        self._stderr_tail = []
        t = threading.Thread(target=self._drain_stderr, daemon=True)
        t.start()
        self._call({"op": "init"})

    def _drain_stderr(self):
        err = self.proc.stderr
        if err is None:
            return
        for line in err:
            if len(self._stderr_tail) < 40:
                self._stderr_tail.append(line[-400:])

    def _call(self, payload, timeout=300):
        if self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("Eden inject bridge pipes closed")
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise RuntimeError("Eden inject bridge timed out")
            line = self.proc.stdout.readline()
            if not line:
                code = self.proc.poll()
                err = "".join(self._stderr_tail)[-4000:]
                raise RuntimeError(f"Eden inject bridge exited code={code} stderr={err!r}")
            line = line.strip()
            if not line.startswith(SENTINEL):
                continue
            result = json.loads(line[len(SENTINEL):].strip())
            if not result.get("ok"):
                raise RuntimeError(f"Eden inject bridge error: {result.get('error')}")
            return result

    def add(self, text):
        self._call({"op": "add", "text": text})

    def flush(self):
        return self._call({"op": "flush"}, timeout=10800)

    def query(self, text):
        return self._call({"op": "query", "text": text}, timeout=180)

    def close(self):
        try:
            self._call({"op": "close"}, timeout=30)
        except Exception:
            pass
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=30)
        except Exception:
            self.proc.kill()


def retrieval_query(agent, message):
    q = ""
    for pat in _QUERY_PATTERNS:
        match = pat.search(message)
        if match:
            q = match.group(1).strip()
            if q:
                break
    if not q:
        extract = getattr(agent, "_extract_retrieval_query", None)
        if callable(extract):
            q = extract(message)
        else:
            q = message
    raw = str(message or "")
    # Official ICL templates end with `label:`; extractors drop it. Restore so
    # product isIclCue sees an ICL cue. Not a stored-shot strip.
    if re.search(r"\blabel\s*:", raw, re.I) and not re.search(r"\blabel\s*:", str(q or ""), re.I):
        q = f"{str(q).rstrip()}\nlabel:"
    return q


_BRIDGE = None


def initialize_eden_agent(agent, agent_config=None):
    config = agent_config or {}
    agent.retrieve_num = config.get("retrieve_num", 10)
    agent.chunk_size = config.get("agent_chunk_size", 4096)
    agent.context = ""
    agent.agent_start_time = time.time()
    _load_eden_env()
    global _BRIDGE
    # One bun process per main.py. Re-init wipes store. Prevents 100 Summ contexts
    # from leaking 100 inject-bridge processes (resource fail-open, not a ranker change).
    if _BRIDGE is None:
        _BRIDGE = EdenBridge()
    else:
        try:
            _BRIDGE._call({"op": "init"})
        except Exception:
            try:
                _BRIDGE.close()
            except Exception:
                pass
            _BRIDGE = EdenBridge()
    agent.eden = _BRIDGE
    print("Eden openMemory inject bridge up (k=10, NIM reader)", flush=True)


def handle_eden_agent(agent, message, memorizing, query_id, context_id):
    if memorizing:
        agent.eden.add(message)
        return "Memorized"

    start_time = time.time()
    flush = agent.eden.flush()
    memory_construction_time = time.time() - start_time
    print(f"Eden inject flush stored={flush.get('stored')}", flush=True)

    q = retrieval_query(agent, message)
    result = agent.eden.query(q)
    packet = result.get("packet") or ""

    from utils.templates import get_template
    from utils.eval_data_utils import format_chat

    system_message = get_template(agent.sub_dataset, "system", agent.agent_name)
    ask = (packet + "\n" + message) if packet else message
    format_message = format_chat(message=ask, system_message=system_message)

    try:
        response = _nim_chat(agent, format_message)
        text = (response.choices[0].message.content or "") if response.choices else ""
        usage = response.usage
        in_tok = getattr(usage, "prompt_tokens", 0) or 0
        out_tok = getattr(usage, "completion_tokens", 0) or 0
    except Exception as err:
        name = type(err).__name__
        # Transport death is not a model miss. Swallowing it as "" scores a fake 0
        # and marks the query processed, so --force cannot resume.
        if any(s in name for s in ("Connection", "Timeout", "ConnectError")):
            print(f"NIM reader failed ({name}); aborting leaf (do not score empty)", flush=True)
            raise
        print(f"NIM reader failed ({name}); empty answer", flush=True)
        text, in_tok, out_tok = "", 0, 0
    text = _icl_complete(text, agent)
    text = _detqa_complete(text, agent)
    query_time_len = time.time() - start_time - memory_construction_time
    return agent._create_standard_response(
        text,
        in_tok,
        out_tok,
        memory_construction_time,
        query_time_len,
    )


def _icl_complete(text, agent):
    """Official ICL prompts end with `label:`; gold is the number only.

    Chat models often echo `label: 18`. That is output format, not context
    label-stripping (k stays 10; stored shots keep `label:`).
    """
    raw = (text or "").strip()
    sub = str(getattr(agent, "sub_dataset", "")).lower()
    if "icl" not in sub:
        return raw
    match = re.match(r"^(?:label\s*:\s*)(.+)$", raw, re.I)
    if match:
        return match.group(1).strip()
    return raw


def _detqa_complete(text, agent):
    """Detective_QA gold is a short choice; Gemma dumps JSON / fences.

    Gold looks like `['C. The Brandt couple']`. The reader often returns
    `{"answer":"C. The Brandt couple", "reasoning":...}` (sometimes inside
    ```json fences). That is output format, like ICL `label: N` → `N`.
    Not stored-shot strip. Fail-open: unwrap errors return original text.
    """
    raw = (text or "").strip()
    try:
        sub = str(getattr(agent, "sub_dataset", "")).lower()
        if "detective" not in sub:
            return raw
        body = raw
        fence = re.search(r"```(?:json)?\s*\n?(.*?)```", body, re.S | re.I)
        if fence:
            body = fence.group(1).strip()
        parsed = None
        start = body.find("{")
        blob = body[start:] if start >= 0 else body
        try:
            parsed, _ = json.JSONDecoder().raw_decode(blob)
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            ans = parsed.get("answer")
            if isinstance(ans, str) and ans.strip():
                return ans.strip()
        match = re.search(
            r'["\']answer["\']\s*:\s*("(?:\\.|[^"\\])*")',
            body,
            re.I,
        ) or re.search(
            r'["\']answer["\']\s*:\s*("(?:\\.|[^"\\])*")',
            raw,
            re.I,
        )
        if match:
            try:
                return str(json.loads(match.group(1))).strip()
            except Exception:
                return match.group(1).strip().strip('"')
        return raw
    except Exception:
        return raw


_NIM_MODEL_LIVE = None
_DEFAULT_NIM_MODEL = "google/gemma-4-31b-it"
_NIM_HTTP = None
_NIM_CLIENT = None
_NIM_CLIENT_KEY = None


def _nim_model():
    global _NIM_MODEL_LIVE
    return _NIM_MODEL_LIVE or os.environ.get("NIM_MODEL") or _DEFAULT_NIM_MODEL


def _nim_extra(model, effort="none"):
    m = (model or "").lower()
    if not any(s in m for s in ("deepseek", "glm", "kimi", "nemotron")):
        return None
    thinking = effort != "none"
    return {
        "reasoning_effort": effort,
        "chat_template_kwargs": {"thinking": thinking, "reasoning_effort": effort},
    }


def _collect_stream(stream):
    parts = []
    reason = []
    usage = None
    for chunk in stream:
        if getattr(chunk, "usage", None):
            usage = chunk.usage
        if not chunk.choices:
            continue
        d = chunk.choices[0].delta
        c = d.content or ""
        rc = getattr(d, "reasoning_content", None) or getattr(d, "reasoning", None) or ""
        if c:
            parts.append(c)
        if rc:
            reason.append(rc)
    text = "".join(parts).strip()
    if not text:
        text = "".join(reason).strip()
    return text, usage


def _as_response(text, usage=None):
    from types import SimpleNamespace

    in_tok = getattr(usage, "prompt_tokens", 0) or 0 if usage else 0
    out_tok = getattr(usage, "completion_tokens", 0) or 0 if usage else 0
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=SimpleNamespace(prompt_tokens=in_tok, completion_tokens=out_tok),
    )


def _nim_client():
    """Reuse one HTTP/OpenAI client for the leaf (same tokens; less handshake)."""
    import httpx
    from openai import OpenAI

    global _NIM_HTTP, _NIM_CLIENT, _NIM_CLIENT_KEY
    _load_eden_env()
    key = os.environ.get("NVIDIA_API_KEY")
    base = os.environ.get("NVIDIA_BASE_URL")
    if not key or not base:
        raise RuntimeError("NVIDIA_API_KEY and NVIDIA_BASE_URL must be set for the NIM reader")
    stamp = (key, base, os.environ.get("NIM_READ_TIMEOUT", "60"), os.environ.get("NVCF_POLL_SECONDS", "30"))
    if _NIM_CLIENT is None or _NIM_CLIENT_KEY != stamp:
        if _NIM_HTTP is not None:
            try:
                _NIM_HTTP.close()
            except Exception:
                pass
        _NIM_HTTP = httpx.Client(
            http2=False,
            timeout=httpx.Timeout(connect=15.0, read=float(os.environ.get("NIM_READ_TIMEOUT", "60")), write=20.0, pool=10.0),
        )
        _NIM_CLIENT = OpenAI(
            base_url=base,
            api_key=key,
            http_client=_NIM_HTTP,
            default_headers={"NVCF-POLL-SECONDS": os.environ.get("NVCF_POLL_SECONDS", "30")},
        )
        _NIM_CLIENT_KEY = stamp
    return _NIM_CLIENT


def _nim_chat(agent, messages, attempts=16):
    global _NIM_MODEL_LIVE, _NIM_CLIENT, _NIM_CLIENT_KEY
    model = _nim_model()
    extra = _nim_extra(model, "none")
    kwargs = dict(
        model=model,
        messages=messages,
        temperature=agent.temperature,
        max_tokens=max(int(agent.max_tokens or 32), 32),
        stream=False,
    )
    if extra:
        kwargs["extra_body"] = extra
    stop_new_line = "icl" in str(getattr(agent, "sub_dataset", "")).lower()
    if stop_new_line:
        kwargs["stop"] = ["\n"]
    last = None
    for i in range(attempts):
        try:
            client = _nim_client()
            resp = client.chat.completions.create(**kwargs)
            if getattr(resp, "choices", None):
                msg = resp.choices[0].message
                text = (msg.content or "").strip()
                if not text:
                    text = (getattr(msg, "reasoning_content", None) or "").strip()
                if _NIM_MODEL_LIVE != model:
                    _NIM_MODEL_LIVE = model
                    print(f"NIM reader using {model}", flush=True)
                return _as_response(text, getattr(resp, "usage", None))
            raise RuntimeError("NIM empty choices")
        except Exception as err:
            last = err
            name = type(err).__name__
            msg = str(err).lower()
            if "stop" in kwargs and any(s in msg for s in ("stop", "unsupported", "invalid", "unexpected")):
                kwargs.pop("stop", None)
                continue
            if "extra_body" in kwargs and any(s in msg for s in ("extra_body", "reasoning_effort", "chat_template")):
                kwargs.pop("extra_body", None)
                continue
            transport = any(s in name for s in ("Connection", "Timeout", "ConnectError"))
            if transport:
                _NIM_CLIENT = None
                _NIM_CLIENT_KEY = None
                wait = min(60.0, 8.0 * (2.0 ** min(i, 3)))
            else:
                wait = min(12.0, 2.0 ** i)
            print(f"NIM retry {i + 1}/{attempts} {model} after {wait:.0f}s: {name}", flush=True)
            time.sleep(wait)
    raise last
