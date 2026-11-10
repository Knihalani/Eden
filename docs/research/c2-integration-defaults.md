# C2: integration defaults (2026-11-10)

Decisions: D420, D421, D422. Base: `main` at 314e2445. Paid calls: none. No engine change: `bun run eval` is the
same as on main (below).

## In plain words

Three things the research found pay off only if the integrator does them; until now each was in a research note, not
on the shortest path. Now an integrator who copies the quickstart gets them.

- **Check before acting (D420).** Eden's party check (A25: followed attacks 12 in 576 tasks → 0) only sees tool calls
  it is sent. Both clients now wrap an agent's acting tools in one line, `guardTools(eden, { send_email, … })`
  (Python `guard_tools`): each call is checked first, a finding comes back to the agent as the tool's result and the
  tool does not run, and calling again goes ahead. Any failure (Eden down, a throwing policy) runs the tool, as if Eden
  were absent. The personal-agent example uses it; the proxy cannot (the agent runs a call between two requests, after
  its answer streamed through), which INTEGRATION.md now says.
- **Ref notices (D421).** The clients already sent refs (D347); the quickstart and the change-notice section now make
  them the default wherever a connector names changed ids, items where the notice carries content, and describe the
  bare signal as the slow fallback with its measured cost (A18: agent's wait p50 1,013 → 6 ms with refs).
- **Hermes (D422).** A Hermes Agent plugin ships in `eden_client.hermes` (installed by copying `examples/hermes/eden`
  to `~/.hermes/plugins/eden`), in the `hermes-eden` shape the lab measured best (+9.7 points hidden and −1.5 s
  against keeping the source tools beside Eden): `ask_context` as a plugin tool, the turn's new packet only (Hermes
  keeps earlier ones, A27), every non-Eden tool call checked (`pre_tool_call` blocks with the held result), tool
  results reported and queued packets appended. INTEGRATION.md documents it with a note on when to keep the source
  tools (acting through them, browsing a whole listing, a source not connected to Eden).

## What was checked, and how

- Hermes' plugin contracts were read in its source at the lab's pin (06433066, fetched into a scratch directory, not
  committed): `hermes_cli/plugins.py` (`register_tool(name, toolset, schema, handler, …)`; `pre_tool_call` results
  `{"action": "block", "message"}` become the tool's result), `model_tools.py` (`post_tool_call` and
  `transform_tool_result` get `tool_name`, `args`, `result`, `session_id`), `agent/turn_context.py` (`pre_llm_call`
  gets `session_id`, `user_message`). Hermes was not run: its dependencies were not installed here (as in A27).
- Tests (all $0, no network):
  - `packages/client/src/guard.test.ts`: held then released, the `held` policy, every fail-open shape (throwing
    checker, throwing policy, malformed finding, throwing `onError`, no server), the tool's own error propagates.
  - `packages/client-python/test_eden_client.py` (`Guard`): the same for `guard_tool`/`guard_tools`, input shapes
    (one argument, keywords), `async` tools.
  - `packages/client-python/test_hermes.py`: what the plugin registers, no user → nothing, ids through `eden_id`,
    one client per session, block on a finding, `EDEN_CHECK_TOOLS`, packets appended, `ask_context`, session end,
    fail-open on every hook.
  - `examples/onboarding/integration-defaults.test.ts`, on the real handler and the shipped default engine with no
    model: A25's mail (a stranger's mail naming `compliance@client-services.example`); `guardTools` holds a
    `send_email` adding that cc after `ask_context` showed it, and sends it on the repeat; a call adding no new party
    proceeds; `sourceChanged` with refs is taken on `/v1/sources/refs` alone (no bare signal) and Eden fetches each
    ref, and an unsynced user's refs fall back to the signal; from Python, `guard_tools` holds and releases the same
    call, and the Hermes plugin injects the turn's packet, answers `ask_context` with the address and blocks then
    releases the call.

## Not done

- No live Hermes run of the shipped plugin: the lab's `hermes-ab.ts` still runs its own plugin over the lab's routes.
  A next run could point `hermes-eden` at `eden_client.hermes` against a lab server to confirm the shipped plugin
  matches the measured arm.
- The proxy does not check tool calls (above). Making it do so would mean buffering and rewriting the model's answer.

## Eval

`bun run eval` (no model), run in this session on main at 314e2445 (changes stashed) and on this branch: precision
0.6842, recall 0.52, falseFireRate 0 on both. The figure recorded with D404 (0.65) is not what main gives today; the
difference is on main, before this branch, and was not investigated here.
