"""One Hermes Agent per stream of hermes-ab.ts: reads tasks as JSON lines on stdin, answers one JSON line each.

Started by the runner with Hermes' own venv python, ``-I`` and ``HERMES_SRC`` (the Hermes checkout) on the path.
``HERMES_HOME`` is the stream's own directory: its ``config.yaml`` names the MCP servers (the source tools, and Eden's
in Eden conditions) and, in Eden conditions, enables the Eden plugin. Each task gets a fresh ``AIAgent`` with a fresh
session, no memory, no context files and no background review, so nothing carries from one task to the next. Its
tools are only the MCP toolsets: no terminal, files, web, browser, code, memory, skills or delegation. The agent's
model endpoint is the runner's proxy (``base_url``), which holds the API key and meters every request.

Request:  {"op": "run", "task", "token", "system", "prompt", "nowMs", "model", "maxIterations", "maxTokens",
           "toolsets": [...]}
Reply:    {"task", "answer", "error", "apiCalls", "completed", "toolCalls": [{"name", "ms", "error"}],
           "systemChars", "toolNames": [...]}
Hermes' own console output goes to stderr; the protocol has stdout to itself.
"""

import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone

PROTOCOL = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

sys.path.insert(0, os.environ["HERMES_SRC"])

import hermes_time  # noqa: E402  (after the path is set)
from run_agent import AIAgent  # noqa: E402

# The sim world's clock: Hermes stamps its system prompt with "Conversation started: <date>" from hermes_time.now().
_NOW_MS = [time.time() * 1000]
hermes_time.now = lambda: datetime.fromtimestamp(_NOW_MS[0] / 1000, tz=timezone.utc)


def reply(obj):
    PROTOCOL.write(json.dumps(obj) + "\n")
    PROTOCOL.flush()


def run(req):
    _NOW_MS[0] = float(req["nowMs"])
    # The Eden plugin reads these at call time: the stream's routes and this task's token.
    os.environ["EDEN_LAB_TASK"] = req["token"]
    calls = []
    started = {}

    def on_start(*args, **kwargs):
        key = kwargs.get("tool_call_id") or (args[0] if args else None)
        started[key] = time.monotonic()

    def on_complete(*args, **kwargs):
        key = kwargs.get("tool_call_id") or (args[0] if args else None)
        name = kwargs.get("tool_name") or kwargs.get("name") or (args[1] if len(args) > 1 else "?")
        t0 = started.pop(key, None)
        calls.append({"name": str(name), "ms": round((time.monotonic() - t0) * 1000) if t0 else None})

    agent = AIAgent(
        base_url=os.environ["HERMES_LAB_BASE_URL"],
        api_key="lab-proxy",
        model=req["model"],
        max_iterations=int(req["maxIterations"]),
        max_tokens=int(req["maxTokens"]),
        enabled_toolsets=list(req["toolsets"]),
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=True,
        skip_background_review=True,
        ephemeral_system_prompt=req["system"],
        # Hermes dates "Conversation started:" from the stamp in the session id before any clock: the sim's.
        session_id=f"{hermes_time.now():%Y%m%d_%H%M%S}_lab{req['token'][:8]}",
        tool_start_callback=on_start,
        tool_complete_callback=on_complete,
    )
    tool_names = [t["function"]["name"] for t in (agent.tools or [])]
    result = agent.run_conversation(req["prompt"])
    # Hermes' built prompt once it has one; before (a turn that failed early), the part the lab gives it.
    system = getattr(agent, "_cached_system_prompt", None) or ""
    messages = result.get("messages") or []
    # The tool calls as the transcript has them (the callbacks' shapes vary between Hermes versions).
    from_messages = [
        tc.get("function", {}).get("name", "?")
        for m in messages
        if isinstance(m, dict) and m.get("role") == "assistant"
        for tc in (m.get("tool_calls") or [])
        if isinstance(tc, dict)
    ]
    return {
        "answer": result.get("final_response") or "",
        "error": result.get("error"),
        "apiCalls": result.get("api_calls"),
        "completed": result.get("completed"),
        "toolCalls": calls if len(calls) == len(from_messages) else [{"name": n, "ms": None} for n in from_messages],
        "systemChars": (
            len(system) + (0 if req["system"] in system else len(req["system"])) if system else len(req["system"])
        ),
        "toolNames": tool_names,
    }


def main():
    # The CLI connects the configured MCP servers before its first turn; a bare AIAgent does not, so the worker does,
    # once: the stream's servers stay connected for all its tasks (the runner binds them to the running task).
    from tools.mcp_tool_discovery import discover_mcp_tools

    names = discover_mcp_tools()
    reply({"op": "ready", "pid": os.getpid(), "mcpTools": names})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        if req.get("op") != "run":
            reply({"task": req.get("task"), "error": f"unknown op {req.get('op')}"})
            continue
        try:
            out = run(req)
        except Exception as e:
            traceback.print_exc()
            out = {"answer": "", "error": f"{type(e).__name__}: {str(e)[:300]}"}
        reply({"task": req["task"], **out})


if __name__ == "__main__":
    main()
