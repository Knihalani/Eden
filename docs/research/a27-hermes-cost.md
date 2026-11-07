# A27: Hermes' cost with Eden (2026-11-07)

Decisions: D385, D386, D387. Base: `claude/lucid-hypatia-v9wqk5` at 2352dfa4. Paid calls: Anthropic only
(`claude-haiku-5-5`, `HAIKU_API_KEY`, ledger `.local/a27/ledger.jsonl`), $0.0124 of a $0.80 cap (three probe runs).

## In plain words

- On Hermes, the agent's own model bill with Eden was 0.610 dollars per 1,000 tasks against 0.440 without it. The
  suspicion was that Eden's plugin puts its context somewhere that makes Hermes' prompt cache miss on every model
  call. **It does not.** Hermes (at the commit the lab pins) appends the plugin's context to the user's message once a
  turn, stores the exact text it sent, and sends that same text again on every later call. We rebuilt Hermes'
  requests from its source and sent them to Anthropic: the second call of each task reads the whole first call,
  Eden's packet included, from the cache. Per task, the Eden arm writes and reads about as many cached tokens as
  Hermes alone.
- So the plugin keeps its placement. One piece of our own advice was wrong: INTEGRATION.md told Hermes integrators to
  have the plugin return earlier packets again, because it thought Hermes dropped them. Hermes keeps them; returning
  them again would repeat them. The advice is corrected.
- The Hermes harness also mis-booked two things, now fixed (lab only). It never recorded Eden's own connector calls,
  so the per-plan connector prices left them out (`Eden conn/t` read 0). And it never split the one-time backfill
  (the cards Eden makes for a new user before the first request) from what Eden spends while the user works, so the
  whole backfill showed as running cost (it is in the $0.221 per 1,000 tasks of one arm and the $0.060 of the other;
  which arm pays depends on which carded an item first). Pi's harness has always split both.
- What remains open: the cost gap itself. It is not the cache layout, so it is in what the arms send (Eden's arms
  send more input and output tokens) and in how much of that is new each task. The next Hermes run splits each arm's
  bill by token class before anything is changed for it.

## 1. Where the cache breaks (it does not)

hermes-agent's Python dependencies could not be installed in this container, so Hermes did not run here.
`packages/sim/src/lab/hermes-cache-probe.ts` rebuilds the chat-completion bodies Hermes sends to the lab's proxy from
its source at the lab's pin (06433066) and passes them through the proxy's own translation (`toAnthropicBody` in
hermes-anthropic.ts), so the cache markers are the ones the run sent: the last tool, the leading system prompt and the
last message block.

What the source says (read, not run):

- **System**: Hermes' prompt (a stable tier, then a volatile tier ending "Conversation started: <date>") + the lab's
  prompt (`ephemeral_system_prompt`), one system message, built once a session (`build_api_messages`).
- **`pre_llm_call`** runs once a turn (`build_turn_context`); its text is appended to the turn's user message
  (`compose_user_api_content`), stamped on that message as `api_content` and sent again unchanged on every call of
  the turn and on later turns ("historical rows replay their `api_content`").
- **`transform_tool_result`**'s return replaces the tool's result in the transcript: stable after it is made.

The probe sends three tasks of two calls each per arm (one Hermes session a task, tasks in sequence, as a stream runs
them), `max_tokens` 1. The stable tier is a reconstruction (Hermes' identity, help and guidance constants read from its
source with Python's `ast`, not executed), so the prompt is shorter than Hermes' real one (1,542-1,892 tokens of prefix
against roughly 4,000 input tokens a request in the run): the layout is what is measured, not the run's absolute
sizes. Packets, tool results and ask answers are rendered from the world's items at the run's sizes (3, 5 and 2
items). Output `packages/sim/lab/a27/probe.txt`:

| arm (layout `lab`) | task 2, call 1: write / read | task 2, call 2: write / read | task 3, call 1 | task 3, call 2 |
| --- | --- | --- | --- | --- |
| hermes | 94 / 1,892 | 975 / 1,986 | 109 / 1,892 | 1,098 / 2,001 |
| hermes-eden | 857 / 1,542 | 194 / 2,399 | 869 / 1,542 | 185 / 2,411 |
| hermes+eden | 857 / 2,036 | 975 / 2,893 | 869 / 2,036 | 1,098 / 2,905 |

Uncached input is 2-4 tokens on every call. Reading it:

- **Within a task** the second call reads everything the first call sent, packet included (hermes-eden's call 2 reads
  2,399 = call 1's 1,542 + 857). Nothing the plugin adds moves between calls.
- **Across tasks** every arm reads the shared prefix (tools and system prompt) and writes only the new turn: the
  user's message (94-109 tokens alone; ~860 with Eden's packet in it).
- **Per task** hermes writes 1,069-1,207 and reads 3,878-3,893 tokens; hermes-eden writes 1,051-1,054 and reads
  3,941-3,953. The layouts cost the same; what differs is which tokens are new: Eden's packet is written at call 1
  and read at call 2, Hermes' tool results are written at its last call and never read (the lab marks the last block
  of every request).
- `--layout split` (a breakpoint at the end of Hermes' stable tier, as Hermes' own `prompt_caching.py` marks it on a
  native Anthropic route) reads the same within one sim day (`probe.txt`); it would only matter on tasks where the
  date line changes (the sim clock moves an hour a task, so at most once or twice a stream). Not adopted.

The first pass of the probe sent both layouts with the same prompt text, so the `split` rows read the `lab` rows'
entries; it was rerun with one nonce a layout. A third run fixed the stand-in items' source labels (they printed
`undefined`; at most a token a call moved) and is the one kept and quoted.

## 2. The plugin and INTEGRATION.md (D385)

The plugin (`packages/sim/lab/hermes/eden/__init__.py`) already does what the source rewards: one `observe` a turn,
the packet appended once, mid-task packets appended to a tool result. It is unchanged. INTEGRATION.md said Hermes'
`pre_llm_call` context is ephemeral and dropped, and told integrators to return the session's earlier packets again;
at 06433066 that is false and would repeat packets. The paragraph now says Hermes keeps the context and the plugin
returns only the new packet. (A16's D336 lesson still holds for integrations that do drop packets: the proxy keeps
them.)

## 3. Booking Eden's connector calls and the backfill (D386)

`hermes-ab.ts` now counts every connector call Eden makes in a stream (`Background.sourceCalls`) and, after the sync
has warmed and the cards are idle, records `setupUsd`, `setupCalls` and `setupSourceCalls`, as pi-ab does. With
them `pi-cost-report.ts` books the backfill as one-time per user and prices Eden's connector calls per plan. Before
this, a Hermes report's `bg run` column held the whole backfill (hermes3: $0.221/1k hermes-eden, $0.060/1k
hermes+eden: the seed's streams share live cards, so the arm that cards an item first pays for it), `one-time` read
$0 "(in-run)", and `Eden conn/t` and Eden's background calls read 0. Calls inside a task's window were already
spanned (`eden.source`), so `Eden conn/t` 0 in hermes3 may be real for warm, payload-pushed tasks; the stream totals
were not recorded at all.

To stop the next run paying for cards the last one made, pass the last run's cards file back in: `--cards-out` names
a file that is replayed as well as appended to (cards-disk.ts), so pointing it at `.local/hx/h-<seed>.cards.jsonl`
replays every card hermes3 made live.

Not run live here: hermes-agent could not be installed in this container. The coordinator's paired run checks it.

## 4. What stays open (D387)

The agent-cost gap is not explained by the layout. hermes3's report: cache-neutral (all input at the plain price)
hermes-eden − hermes is +0.103 $/1k (+0.044..+0.163) of the +0.171 billed; neutral tasks send +819 input and +60
output tokens a task. A rough split from the report's own means (input at 0.1×/1.25×/1× for read/write/plain,
assuming no plain input as in the probe) puts hermes' writes at ~15% of its input and hermes-eden's at ~27%: about
1,200 more tokens written a task, the size of a packet plus its ask answer. Check this on the run's own requests
(each request's `cached` and `cacheWrite` are in the timeline) before changing anything:

```bash
python3 -I packages/sim/lab/cl8/cache.py .local/hx/h-41.timeline/tasks.jsonl .local/hx/h-42.timeline/tasks.jsonl
```

## Reproduce

```bash
# Hermes' constants, read with ast (not executed), from a hermes-agent checkout at 06433066:
python3 -I packages/sim/lab/a27/pull_consts.py hc.json DEFAULT_AGENT_IDENTITY,HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS,PARALLEL_TOOL_CALL_GUIDANCE,TASK_COMPLETION_GUIDANCE,TOOL_USE_ENFORCEMENT_GUIDANCE $HERMES/agent/*.py
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/hermes-cache-probe.ts --suite train1 --seed 41 \
  --hermes-consts hc.json --spend-ledger .local/a27/ledger.jsonl --spend-cap 0.8 --run-label a27-probe3
```

`pull_consts.py` (beside probe.txt) writes the named top-level string constants as JSON (`ast.literal_eval`); without
`--hermes-consts` the probe uses a same-length stand-in.

The paired check (the coordinator runs Hermes locally; old plugin = base tip, new = this branch; the plugin is
unchanged, so the pair checks the harness's booking: one-time backfill, Eden's connector calls):

```bash
# in each worktree (base 2352dfa4, then claude/a27-hermes-cost), H and P as in audit-1107/hermes/run3.sh:
for S in 41 42; do
  env -u OPENROUTER_API_KEY bun packages/sim/src/lab/hermes-ab.ts --hermes-src $HERMES --concurrency 3 \
    --suite train1,train2,train3,train4,train5,train6 --limit 6 --variants hidden,control,neutral --time-scale 1 \
    --config default --conditions hermes-eden,hermes+eden --budget 1 --seeds $S \
    --cards packages/sim/lab/cards/cards-v2.jsonl --cards-out .local/hx/h-$S.cards.jsonl $H $P \
    --spend-ledger .local/a27/ledger.jsonl --spend-cap 1.5 --run-label a27-<old|new>-$S --out .local/a27/<old|new>-$S.json
done
bun packages/sim/src/lab/pi-cost-report.ts .local/a27/<old|new>-4{1,2}.json
python3 -I packages/sim/lab/cl8/cache.py .local/a27/<old|new>-4{1,2}.timeline/tasks.jsonl
```

Expect: agent $/1k the same in both (the plugin did not change); on the new side `one-time $/user` from the
backfill and Eden's connector calls a task above 0; with the cards replayed, `bg run` near $0 in both arms.
