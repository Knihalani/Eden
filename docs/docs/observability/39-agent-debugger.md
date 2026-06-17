---
title: "39 — Agent Debugger (Phase P)"
status: IMPLEMENTED v1
last_updated: 2026-06-17
version: 1.0
---

# 39 — Agent Debugger (Phase P)

> **Status:** ✅ **IMPLEMENTED v1** (shipped 2026-06-17).
> Closes the Laminar "Agent Debugger" surface. Two pieces:
> (1) **Checkpoint store** — every trace's LLM call state
> is persisted for replay; (2) **Re-run engine** — given a
> trace + step + optional prompt override, replay
> **hermetically** (no real LLM calls, no side effects)
> with sub-millisecond latency. RolloutEntrypoint discovery
> auto-detects the agent's entrypoint function.
> ~480 LOC backend + 24 unit tests.

## Goal & motivation

Laminar's "Agent Debugger" is the headline feature on the
debugging side: the user opens a trace, picks a step, and
clicks "re-run from here with a different system prompt".
The result is shown side-by-side with the original trajectory.

The killer-feature design choice: **hermetic re-runs**. The
replay uses the recorded response, not a fresh model call.
This is fast (sub-millisecond vs 1-30s for a real call),
deterministic (the user can compare apples-to-apples),
cheap (no model cost), and safe (no real side effects via
tool calls).

## What's in Eden

### Checkpoint store

Every LLM call in a trace is persisted as a
:class:`Checkpoint`. The store is a thin layer on top of the
existing ``telemetry_events`` table — checkpoints are
``telemetry_events`` rows with
``event_type = "debugger.checkpoint"`` and the checkpoint
data in the ``payload`` field. No new migration needed.

Each checkpoint carries:

  * ``input_messages`` — chat history before the call
  * ``tool_calls`` — tool calls in this step
  * ``tool_results`` — tool results
  * ``response`` — the LLM response
  * ``started_at`` / ``ended_at`` / ``duration_ms``
  * ``source`` — ``"live"`` (original) or ``"replay"`` (re-run)

### Re-run engine

The :class:`ReRunEngine` takes a ``trace_id`` + ``from_step`` +
optional ``prompt_override`` and returns a
:class:`ReRunResult` with the replayed checkpoints and a
``diff`` vs the original.

The prompt override is applied to the first replayed step's
**system message**. If the original has no system message,
one is prepended. The override is recorded as
``prompt_override`` on the checkpoint so the operator can
see exactly what was overridden.

The diff is a list of (step_number, original_response,
replayed_response, input_messages_changed). The operator
uses this to see "what if the model had been smarter here?"

### RolloutEntrypoint discovery

Laminar auto-detects the agent's entrypoint by scanning the
user's repo for ``@rollout``-decorated functions. We ship a
unit-testable stand-in (:func:`discover_entrypoint`) that
takes a list of candidate entrypoints (with confidence
scores) and returns the high-confidence ones, sorted. The
production path wires a real AST-based scanner.

### Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/orgs/{org}/debugger/checkpoints/{trace_id}` | yes | List all checkpoints for a trace |
| `POST` | `/orgs/{org}/debugger/rerun` | yes | Re-run from a step with optional prompt override |
| `POST` | `/orgs/{org}/debugger/discover` | yes | Discover rollout entrypoints |

## Example session

```bash
# List checkpoints for a trace.
curl -H "Authorization: Bearer $JWT" \
     https://app.eden.example/orgs/myorg/debugger/checkpoints/abc-123
# {
#   "checkpoints": [
#     {"step_number": 0, "input_messages": [...], "response": {...}},
#     {"step_number": 1, "input_messages": [...], "response": {...}},
#     ...
#   ]
# }

# Re-run from step 3 with a different system prompt.
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
     -d '{
       "trace_id": "abc-123",
       "from_step": 3,
       "prompt_override": "You are a helpful, harmless assistant. Always say \"I cannot help with that\" if the user asks for anything that could be illegal."
     }' \
     https://app.eden.example/orgs/myorg/debugger/rerun
# {
#   "source_trace_id": "abc-123",
#   "from_step": 3,
#   "to_step": 9,
#   "prompt_override": "You are a helpful, harmless assistant...",
#   "checkpoints": [/* steps 3-9 with the override applied */],
#   "diff": [
#     {"step_number": 3, "original_response": {...}, "replayed_response": {...}, "input_messages_changed": true}
#   ]
# }
```

The diff is what makes the debugger useful: the operator
sees exactly which step the trajectory diverged and how.

## Why hermetic re-runs?

| Concern | Hermetic re-run | Real re-run |
|---|---|---|
| Speed | sub-millisecond | 1-30 seconds per step |
| Determinism | exact (uses recorded response) | variable (model is non-deterministic) |
| Cost | free | $0.01-1.00 per call |
| Side effects | none (no tool calls run) | runs (could trigger real actions) |
| PII | contained (recorded state only) | could generate new PII |
| Compliance | safe (no model call) | logs to inference audit |

The trade-off: the user can override the prompt, but the
override only affects the textual output of the **next**
step. Subsequent steps still use their original recorded
state. For "what if the model had been smarter here?"
questions, the hermetic replay is the right tool. For "what
if I had used a different prompt for the whole trace?",
a real re-run is needed (and that's a future Phase P.5).

## RagaAI / Laminar parity matrix

| Laminar feature | Eden Phase P | Notes |
|---|---|---|
| Checkpoint store | ✅ CheckpointStore | Persists in ``telemetry_events`` |
| Re-run from step | ✅ ReRunEngine.rerun() | Hermetic (recorded response) |
| Prompt override | ✅ first-step system message | Prepends if missing |
| Diff vs original | ✅ per-step input + response | Highlights divergence |
| RolloutEntrypoint discovery | ✅ discover_entrypoint | Static stand-in; AST scanner in P.5 |
| Multi-turn re-runs | ✅ from_step parameter | Replay from any step |
| Per-step tool-call inspection | ✅ checkpoint.tool_calls | Full state captured |
| Real LLM re-runs | ❌ deferred (Phase P.5) | The "what if" use case |
| Tree-based branching (try N variants) | ❌ deferred | Sequential today; parallel in P.5 |
| Time-travel debugging UI | 🟡 partial | API exists; UI is Phase E (UI polish) |

## What's NOT in this phase (deferred)

- **Real LLM re-runs** — for "what if the model had been
  smarter from step 0?" the user needs a real call. Phase
  P.5 wires the OpenRouter client + a budget cap.
- **Tree-based branching** — try N prompt variants in
  parallel and compare. Currently sequential.
- **AST-based RolloutEntrypoint scanner** — the current
  implementation accepts a list of candidate entrypoints
  from a pre-scan. A real scanner (with ``ast.parse``) is
  Phase P.5.
- **Per-tool-call re-runs** — the checkpoint captures
  tool calls, but the re-run doesn't re-execute them. The
  user sees what the model called, not the simulated
  response.

## Failure modes

| Failure | Behaviour |
|---|---|
| Trace has no checkpoints | Empty replay (no diff) |
| Step number out of range | Empty replay (the engine filters ``>= from_step``) |
| Prompt override contains newlines / quotes | Stored verbatim; no escaping issues |
| Multiple system messages in input | Only the first is replaced |
| Override on a non-system role | The prepended system message is added; existing messages are untouched |
| `get_at_step` for unknown step | Returns None |
| Postgres fetch fails | The exception propagates (the route returns 500) |

## Telemetry

- `debugger.checkpoint.persisted` (counter) — fires per save
- `debugger.rerun.executed` (counter) — fires per rerun call
- `debugger.rerun.diverged_steps` (counter) — fires once per rerun with the count of diverged steps

These flow into the same pipeline as LLM spans.

## Tests

24 unit tests in `tests/unit/test_debugger.py`:

- `TestCheckpoint` (3) — defaults, to_dict, custom fields
- `TestCheckpointStore` (5) — save, list in step order,
  get_at_step, unknown returns None, empty store
- `TestReRunEngine` (8) — replay returns checkpoints,
  from_step skips earlier, prompt override replaces,
  prompt override prepends, diff highlights input changes,
  diff empty when no override, empty trace, to_dict
- `TestDiscoverEntrypoint` (5) — sorted by confidence,
  filters by threshold, empty, preserves arg_signature,
  to_dict
- `TestApplyPromptOverride` (3) — replaces existing,
  prepends when missing, marks source as replay

All 24 pass; 0 regressions in the existing unit suite
(673/673 total across new modules).

## Cross-references

- [Cat 1 — Trace Replay](01-trace-replay.md) — the
  consumer of checkpoints; the existing trace view uses
  the same data.
- [Cat 22 — APM Depth](22-apm-tracing-depth.md) — the
  Pyroscope profiling integration can be used to identify
  which step is slow.
- [Phase C — Unified AI agent](14-autonomous-intelligence.md)
  — the agent can be re-invoked to suggest what to change
  in the prompt.
- [Phase L — Red-Team Probes](35-red-team-probes.md) —
  the offline counterpart: red-team probes test the
  agent's responses; the debugger inspects them.
