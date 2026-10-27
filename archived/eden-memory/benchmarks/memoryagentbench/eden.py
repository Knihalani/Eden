"""not-product: Eden BrainMemory as a MemoryAgentBench agent (not wrap/hook inject).

Driven through a newline-delimited JSON bridge (benchmarks/memoryagentbench/mab-bridge.ts).
Set EDEN_BRIDGE to the TypeScript file and EDEN_ROOT to the Eden checkout; the harness
runs it with `bun`.
"""

import json
import os
import re
import subprocess
import time

SENTINEL = "@@EDEN@@"

_ICL_LABEL = re.compile(r"label:\s*(\d+)", re.I)
_QUERY_PATTERNS = [
    re.compile(r"Now Answer the Question:\s*(.*)", re.S),
    re.compile(r"Here is the conversation:\s*(.*)", re.S),
    re.compile(r"Question:\s*(.*?)(?:\n\s*label:|\Z)", re.S),
    re.compile(r"complete the task below:\s*(.*?)(?:\n\s*The event that happens next is:|\Z)", re.S | re.I),
]


class EdenBridge:
    def __init__(self):
        bridge_path = os.environ.get("EDEN_BRIDGE")
        root = os.environ.get("EDEN_ROOT")
        if not bridge_path or not root:
            raise RuntimeError("Set EDEN_BRIDGE (mab-bridge.ts) and EDEN_ROOT (Eden checkout)")
        bun = os.environ.get("EDEN_BUN", "bun")
        self.proc = subprocess.Popen(
            [bun, bridge_path],
            cwd=root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._call({"op": "init"})

    def _call(self, payload, timeout=300):
        if self.proc.stdin is None or self.proc.stdout is None:
            raise RuntimeError("Eden bridge pipes closed")
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise RuntimeError("Eden bridge timed out")
            line = self.proc.stdout.readline()
            if not line:
                err = ""
                if self.proc.stderr:
                    err = self.proc.stderr.read()[:4000]
                code = self.proc.poll()
                raise RuntimeError(f"Eden bridge exited code={code} stderr={err!r}")
            line = line.strip()
            if not line.startswith(SENTINEL):
                continue
            result = json.loads(line[len(SENTINEL):].strip())
            if not result.get("ok"):
                raise RuntimeError(f"Eden bridge error: {result.get('error')}")
            return result

    def add(self, text):
        self._call({"op": "add", "text": text})

    def flush(self):
        return self._call({"op": "flush"}, timeout=1200)

    def query(self, text, k):
        return self._call({"op": "query", "text": text, "k": k}, timeout=180)

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


def format_retrieval_memory_string(contents, cap_chars=24000):
    labelled = []
    used = 0
    for i, text in enumerate(contents):
        piece = f"Memory {i + 1}:\n{text}\n"
        if used and used + len(piece) > cap_chars:
            break
        labelled.append(piece)
        used += len(piece)
    return "\n".join(labelled)


def retrieval_query(agent, message):
    for pat in _QUERY_PATTERNS:
        match = pat.search(message)
        if match:
            q = match.group(1).strip()
            if q:
                return q
    return agent._extract_retrieval_query(message)


def is_icl_prompt(message):
    return "Only output" in message and "label:" in message.lower()


def initialize_eden_agent(agent, agent_config=None):
    config = agent_config or {}
    agent.retrieve_num = config.get("retrieve_num", 10)
    agent.chunk_size = config.get("agent_chunk_size", 4096)
    agent.context = ""
    agent.agent_start_time = time.time()
    agent.eden = EdenBridge()
    print("Eden BrainMemory bridge up")


def handle_eden_agent(agent, message, memorizing, query_id, context_id):
    if memorizing:
        agent.eden.add(message)
        return "Memorized"

    start_time = time.time()
    flush = agent.eden.flush()
    memory_construction_time = time.time() - start_time
    print(f"Eden flush kind={flush.get('kind')} episodes={flush.get('episodes')}", flush=True)

    q = retrieval_query(agent, message)
    k = 40 if is_icl_prompt(message) else agent.retrieve_num
    result = agent.eden.query(q, k)
    contents = result["contents"]
    retrieval_memory_string = format_retrieval_memory_string(contents)

    from utils.templates import get_template
    from utils.eval_data_utils import format_chat

    system_message = get_template(agent.sub_dataset, "system", agent.agent_name)
    ask = retrieval_memory_string + "\n" + message
    format_message = format_chat(message=ask, system_message=system_message)

    response = _openrouter_chat(agent, format_message)
    text = (response.choices[0].message.content or "") if response.choices else ""
    if is_icl_prompt(message):
        # Unofficial convenience: official parse_output keeps the first line, so
        # "label: 43" vs gold "43" is a miss. Strip only so a prompt-following
        # reader is not zeroed; do not quote those scores as Table 3 MCC.
        m = _ICL_LABEL.search(text)
        if m:
            text = m.group(1)
    usage = response.usage
    query_time_len = time.time() - start_time - memory_construction_time
    return agent._create_standard_response(
        text,
        getattr(usage, "prompt_tokens", 0) or 0,
        getattr(usage, "completion_tokens", 0) or 0,
        memory_construction_time,
        query_time_len,
    )


def _openrouter_chat(agent, messages, attempts=8):
    import httpx
    from openai import OpenAI

    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    http = httpx.Client(http2=False, timeout=180.0)
    client = OpenAI(
        base_url=os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        api_key=key,
        http_client=http,
        default_headers={
            "HTTP-Referer": "https://github.com/KaiavN/Eden",
            "X-Title": "Eden MemoryAgentBench",
        },
    )
    last = None
    kwargs = dict(
        model=agent.model,
        messages=messages,
        temperature=agent.temperature,
        max_tokens=max(agent.max_tokens or 32, 64),
    )
    use_reasoning_off = True
    for i in range(attempts):
        try:
            if use_reasoning_off:
                try:
                    return client.chat.completions.create(**kwargs, extra_body={"reasoning": {"enabled": False}})
                except Exception as inner:
                    msg = str(inner).lower()
                    if "free-models-per-day" in msg:
                        raise
                    transient = any(s in msg for s in ("connection", "timeout", "429", "rate", "503", "502", "overloaded"))
                    if transient:
                        raise
                    print(f"reasoning-off rejected, using plain chat: {inner}")
                    use_reasoning_off = False
                    return client.chat.completions.create(**kwargs)
            return client.chat.completions.create(**kwargs)
        except Exception as err:
            last = err
            msg = str(err).lower()
            if "free-models-per-day" in msg:
                raise RuntimeError(f"OpenRouter daily free-tier cap: {err}") from err
            wait = min(60.0, 2.0 ** i)
            print(f"OpenRouter retry {i + 1}/{attempts} after {wait:.0f}s: {err}")
            time.sleep(wait)
    raise last
