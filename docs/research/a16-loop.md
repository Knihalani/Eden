# A16: the agent's loop around Eden

Status: 2026-11-07, branch `claude/a16-moonshot-loop` (from `claude/lucid-hypatia-v9wqk5` at `598bd6ebe`). Decisions
D335–D337. Every paid call went to the Anthropic API with `HAIKU_API_KEY` (`claude-haiku-5-5` as agent, grader, cards
and intent; Sonnet 5.5 only for concern regrades) through the lab provider (D97), `OPENROUTER_API_KEY` unset, on one
ledger (`.local/a16/ledger.jsonl`, hard cap $2.50): **Anthropic-direct lab figures**, train only (seeds 41–42), with
the tenant's house rules in every arm (`--tenant-prompt`, D271) and payload notices. **Spent: $0.930**
(`packages/sim/lab/a16/spend.txt`). Numbers marked **[EST]** are arithmetic, not measured.

## In plain words

- **Where the agent's money goes around Eden.** On Pi, a turn in which the agent calls `ask_context` costs about 190
  output tokens before Eden answers anything: a sentence telling the user it will look (~50 tokens), each call's own
  overhead (~39) and a full-sentence question (~144 characters in the pilot, ~57 tokens), 1.5 calls a turn. With the
  cache write of the answer and a re-read of the prompt, one such turn is about $0.17 per 1,000 tasks and ~1.4 s
  **[EST]**. Eden's agent makes 0.57 such turns a nothing-to-add task; the agent alone makes 0.86 search turns of its
  own.
- **The biggest finding is not in Eden's engine but in how integrations keep its packets.** Pi in the lab keeps every
  packet in the agent's transcript. Our own `withContext` helper and the `@eden/proxy` do not: they insert the current
  packet and leave the old ones out. On Anthropic's prompt cache, whose entries end where the request marks them, a
  packet that vanishes from the middle of the history makes the next request a stranger: the history after it is
  written to the cache again on every turn. Measured over a user's days on Pi: **+$0.057 per 1,000 tasks**
  (+0.039..+0.075) against keeping the packets, so a real integration following our docs paid about +$0.095 against
  the agent alone where the lab said +$0.038. It also lost facts: Eden never shows an item twice in a session, so an
  item first shown in an earlier packet lives only there (5 of 23 hidden facts over the days); with the packets kept the
  agent raised 2 of those 5, without them 0.
  **Fixed (D336):** the proxy now keeps every earlier turn's packet where it was (`keepPackets`, on by default), and
  INTEGRATION.md, `withContext`'s and `with_context`'s docs tell SDK users to keep the message in their transcript.
- **Search-like ask questions were built, measured and deleted (D335).** One sentence in the ask tool's description
  ("Write the question like a search, in a few words naming the person, thing or date") cut questions from ~155 to ~45
  characters and a turn that asks from ~175 to ~155 output tokens. **One request at a time it saved nothing** (+$0.000
  per 1,000, −0.016..+0.017; the agent asked more often, 0.74 → 0.97 a nothing-to-add task). **Over a user's days it
  saved $0.016 per 1,000 (−0.026..−0.005) and 0.09 s, but the agent asked half as often (0.108 → 0.052 a task) and
  raised fewer hidden facts** (16 → 13 of 23, −13.0 points, −26.1..+0.0): D257's trap, the ask that finds what the push
  missed. Pooled over the four runs hidden facts read +3.0 points (−3.6..+9.6). A small saving on one horizon with a
  recall risk on the other is not D112's "better or neutral", so the wording and its trial flag are deleted.
- **The cheapest layout was rejected.** Dropping old packets but marking the user's turn as a cache point cost
  −$0.038 per 1,000 against keeping them, level with the agent alone over days (+0.001, −0.016..+0.016) and 0.76 s
  faster, but it loses the same earlier-packet facts (0 of 5). It would need Eden to re-send an item whose packet the
  agent no longer holds; not built.
- **Rejected on paper or after a $0.03 smoke (D337):** the proxy answering `ask_context` itself (same tokens; it saves
  only the agent's own round trip: on Pi the whole gap between the two model calls is ~6 ms, Eden's ask included),
  starting the agent's call before the packet (D248; Eden's path is now 7–11 ms), cache marks only where a later read is
  likely (≤ ~$0.01 per 1,000 [EST], the agent framework's call), packet wording that says facts are verified (D237 says
  nothing has checked them; Eden's longer answers carry real details), and asking the agent not to narrate or to make
  one call per thing (Haiku kept narrating and made more calls).

## 1. Where the tokens go in a turn that asks

Pilot (`a16-pilot-41`, tools and eden, seed 41, `--limit 4`, 72 tasks an arm; `a16-pilot2-41`, eden again with the
per-turn fields added to Pi's timeline: each request's text length, tool calls and a tool turn's text).
`packages/sim/lab/a16/turns.py` splits each arm's output by turn type:

| (short, n 144 a kind, seeds 41–42) | requests | tool turns | out / tool turn | out / final turn | out / task | asks | question chars |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tools, neutral | 1.86 | 0.86 | 196 | 161 | 331 | – | – |
| eden, neutral | 1.57 | 0.57 | 169 | 180 | 277 | 0.74 | 155 |
| eden, hidden | 1.21 | 0.21 | 188 | 230 | 269 | 0.31 | 158 |
| eden+terse, neutral | 1.53 | 0.53 | 153 | 178 | 259 | 0.97 | 44 |

A least-squares fit over the pilot's 24 eden tool turns: output ≈ −8 + 0.36 a text character + 39 a call + 0.39 a
question character. Every tool turn carried text (a sentence such as "I need to find Ilse Marchetti and the Corvalis
quote before I can draft anything", ~140 characters), 1.54 calls and 144 question characters on average. Eden's final
answers run longer than the agent alone's on control tasks (+59 tokens in the pilot); read by hand, the extra words are
details from the packet (a flight clashing with the requested slot, a cancellation fee rule), not restated sources.

## 2. Cache layouts over a session (D336)

`session-cache-probe.ts` sends six requests of one session as pi-ai builds them (the eden arm's tools and system
prompt with the tenant rules; ~400-token packets, ~200-token answers), `max_tokens` 1
(`packages/sim/lab/a16/session-probe.txt`, $0.003):

| layout | cache writes per request | cache reads per request | 6 requests $ |
| --- | --- | --- | --- |
| kept (Pi's transcript) | 886, 1,111, 1,126, 1,114, 1,115, 1,121 | 1,045 → 6,397 | 0.00103 |
| ephemeral (`withContext`, the proxy before D336) | 889, 1,224, 1,574, 1,912, 2,251, 2,596 | 1,045 each | 0.00137 |
| ephemeral + a mark on the user turn | 892, 1,113, 1,128, 1,116, 1,117, 1,123 | 1,045 → 2,521 | 0.00092 |

pi-ai holds a system message back until the next assistant message, so a packet placed before the user turn is sent
after it (`--dump`); every layout's packet follows its user turn on the wire. Anthropic writes cache entries only at
marked points (pi-ai marks the last tool, the system prompt and the last message): when a packet disappears no entry
ends before it, and everything after the system prompt is written again. On the long runs the ephemeral arm read
some history (2,082 tokens at a first request, against 5,861 kept): requests where Eden stayed silent leave an entry
ending at the user turn that the next request can still read.

**Live, Pi, `--days 8`, users 41 and 42** (232 graded tasks an arm, 1:1:8 mix; `long-arms.txt`, `long-cache.txt`,
`pooled.txt`):

| arm | $/1k mix | − kept eden | − tools | wall mean | hidden raised | cache read / write a neutral task |
| --- | --- | --- | --- | --- | --- | --- |
| tools | 0.203 | | | 2.08 s | 1/23 | 5,699 / 313 |
| eden (kept) | 0.241 | | +0.038 (+0.019..+0.058) | 1.36 s | 16/23 | 6,496 / 630 |
| eden+ephemeral | 0.298 | **+0.057 (+0.039..+0.075)** | +0.095 (+0.076..+0.115) | 1.36 s | 14/23 | 2,210 / 1,423 |
| eden+ephemeralBp | 0.204 | −0.038 (−0.049..−0.027) | +0.001 (−0.016..+0.016) | 1.32 s | 13/23 | 2,954 / 635 |

Where each hidden task's planted item reached the agent (`earlier.py`, `long-earlier.txt`; raised in brackets):

| arm | this request's packet | an ask | only an earlier packet that day | nowhere |
| --- | --- | --- | --- | --- |
| eden (kept) | 13 (12) | 1 (1) | 5 (2) | 4 (1) |
| eden+ephemeral | 14 (14) | 0 | 5 (0) | 4 (0) |
| eden+ephemeralBp | 14 (13) | 0 | 5 (0) | 4 (0) |

Hidden raised pooled, ephemeral − kept −8.7 points (−26.1..+8.7), ephemeralBp − kept −13.0 (−30.4..+4.3), n 23:
not significant alone, but the earlier-packet column is the mechanism (an item Eden delivered once is not delivered
again in the session, `Session.delivered`, while the integration has dropped the packet that held it). Regraded
concerns (Sonnet): 0 in every arm. One request at a time the layouts are the same request by construction (pi-ab
refuses them without `--day`/`--days`).

**What changed.** `@eden/proxy` keeps each turn's packet text per conversation, keyed by its user message together
with the message before it (and which copy of that pair it is), and re-inserts it there on every later request, Eden
up or down. A new turn never takes an older turn's placement, even with the same words; a request overtaken by a newer
turn neither shows nor keeps that turn's packets; past 64 KB (UTF-8) a conversation, placements whose message has left
the request go first, then the oldest (at most 640 MB over the default 10,000 conversations); a request with no user
message gets the turn's packets where `withContext` puts them. `EDEN_PROXY_KEEP_PACKETS=0` restores the old
behaviour. The review found the first version keyed by copy number alone (a sliding window moved a packet to another
"yes"; an agent that sends only its latest message got an old turn's packet back) and stored an overtaken request's
packets for good; each is now a test in `proxy-a16.test.ts` that fails on that version. **Promoted directly, not as
a trial:** it corrects a contradiction between the integration and the engine (Eden delivers an item once per session
and assumes the agent keeps it), adds no paid call, and makes the proxy do what INTEGRATION.md already promised (an
unchanged prefix). The SDKs are
stateless: their docs and INTEGRATION.md say to keep the returned message in the transcript (the README's example
already does). Not measured: the proxy's own path to a provider (the Pi harness emulates the layouts on the wire), and
providers with automatic prefix caching (OpenAI's), where dropping a packet costs only the turn after it and keeping
it costs its re-reads; the recall argument holds there too.

## 3. Search-like questions (D335)

The trial wording added one sentence to the ask tool and a description of its parameter. A first version also asked
for "one call for each thing in the same step" and "do not tell the user you are looking something up": in a 72-task
smoke Haiku kept narrating every tool turn and made 1.9 calls a turn against 1.6, so it was cut to the question's shape
only before the measured runs.

| eden+terse − eden (1:1:8 mix) | short (seeds 41–42, `--limit 12`) | long (`--days 8`) |
| --- | --- | --- |
| $/1k | +0.000 (−0.016..+0.017) | **−0.016 (−0.026..−0.005)** |
| wall mean | −0.09 s (−0.52..+0.34) | **−0.09 s (−0.14..−0.04)** |
| turns a task | −0.02 | −0.06 |
| asks a task (neutral) | 0.74 → 0.97 | 0.12 → 0.05 |
| hidden raised | +5.6 points (−2.1..+13.2), n 144 | −13.0 (−26.1..+0.0), n 23 |
| pooled, 4 runs | hidden +3.0 points (−3.6..+9.6), n 167; regraded concerns +0.0, n 497 | |

Wall p50/p90 on neutral: short eden 2.37/4.42 s, terse 2.13/4.03 s, tools 3.45/6.96 s; long eden 1.23/1.91 s, terse
1.20/1.60 s, tools 1.23/3.82 s. Seed 41's short run hit 79 rate-limit retries (all arms in one process), so its wall
times are noisier than its costs.

**Verdict: deleted.** One request at a time it changed nothing that matters; over days its saving came with half the
asks and three fewer hidden facts of 23 (an interval that reaches zero, on the horizon where the asks are rare and each
one that is lost may be the fact). The trial wording, `ASK_QUESTION_DESCRIPTION` and pi-ab's `+terse` are gone; the
results stay in `packages/sim/lab/a16/` (`eden+terse` rows). A larger multi-day run would be needed to tell the recall
drop from noise; the payoff (at most $0.016 per 1,000 and 0.09 s over days) does not justify it now.

## 4. Against the agent alone, with connectors per plan

Token dollars (`arms.py`'s mix `usd`) plus connector calls a task at market.py's per-call prices
(`connector-price.txt`; background sync listings and the one-time backfill are not included, as in A6 §6):

| run | arm | tokens $/1k | calls a task | Composio | Arcade.dev | Zapier MCP |
| --- | --- | --- | --- | --- | --- | --- |
| short | tools | 0.237 | 2.30 | 0.927 | 23.23 | 59.55 |
| short | eden | 0.279 | 0.00 | 0.279 | 0.279 | 0.279 |
| long | tools | 0.203 | 1.14 | 0.545 | 11.59 | 29.59 |
| long | eden (kept packets) | 0.241 | 0.15 | 0.287 | 1.79 | 4.24 |
| long | eden, ephemeral (old proxy) | 0.298 | 0.15 | 0.344 | 1.85 | 4.30 |

Against the agent alone on tokens only, eden is +$0.041/1k short (+0.023..+0.060) and 1.05 s faster, +$0.038/1k over
days with packets kept (+0.019..+0.058) and 0.72 s faster; hidden raised +55.7 points pooled (+47.3..+63.5).

## 5. Ideas, ranked

| # | Idea | Axis | Payoff | Status |
| --- | --- | --- | --- | --- |
| 1 | Keep packets where the agent saw them | cost over days, recall | −$0.057/1k against what integrations sent; keeps earlier-packet facts | **measured, adopted (D336)** |
| 2 | Search-like ask questions | output tokens | short level; long −$0.016/1k, −0.09 s, half the asks, −3/23 hidden | measured, deleted (D335) |
| 3 | Drop old packets, mark the user turn | cost over days | −$0.038/1k against kept; loses 2 of 5 earlier-packet facts | measured, rejected (D336) |
| 4 | Answer-ahead: pre-run the agent's likely ask | turns | session A9's | not duplicated |
| 5 | The proxy runs `ask_context` itself and continues | latency | < 6 ms an ask on Pi; tokens unchanged | rejected on paper (D337) |
| 6 | Start the first call before the packet, splice later | latency | Eden's path is 7–11 ms; D248 measured worse | rejected (D337, D248) |
| 7 | Cache marks only where re-read | cost | ≤ ~$0.01/1k [EST]; the agent framework's | rejected on paper (D337) |
| 8 | "Facts verified, do not restate" packet wording | output | contradicts D237; extra words are details | rejected on paper (D337) |
| 9 | No narration, one call per thing | output | Haiku narrated anyway; more calls | smoke, dropped (D337) |

## 6. Decisions

- **D335**: a few-word, search-like `ask_context` question (trial `+terse`, opened and closed this session): measured,
  not better on both horizons, recall risk over days; deleted with its flag.
- **D336**: keep each packet where the agent saw it: `@eden/proxy` `keepPackets` on by default; the SDKs' and
  INTEGRATION.md's guidance; lab layouts `+ephemeral`, `+ephemeralBp`, `session-cache-probe.ts` and Pi's per-turn
  timeline fields kept as instruments; the cheaper drop-and-mark layout rejected for recall.
- **D337**: rejected on paper or smoke: ideas 5–9 above.

## 7. Reproduce

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/a16/cards-all.jsonl
R=packages/sim/lab/a16/run.sh
$R a16-pilot-41 payload tools,eden --seeds 41 --variants hidden,control,neutral --limit 4 --budget 0.12
$R a16-short-41 payload tools,eden,eden+terse --seeds 41 --variants hidden,control,neutral --limit 12 --budget 0.4  # 42
$R a16-long-41 payload tools,eden,eden+ephemeral,eden+ephemeralBp,eden+terse --seeds 41 --days 8 --budget 0.35   # 42
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/session-cache-probe.ts --requests 6 \
  --spend-ledger .local/a16/ledger.jsonl --spend-cap 2.5 --run-label a16-session-probe
S=.local/a16/runs; O=packages/sim/lab/a16
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden,eden+ephemeral,eden+ephemeralBp,eden+terse $S/a16-long-4{1,2}
python3 -I packages/sim/lab/cl8/cache.py $S/a16-long-4{1,2}; python3 -I $O/turns.py $S/a16-short-4{1,2}
python3 -I $O/earlier.py $S/a16-long-4{1,2}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $S/a16-short-41.json \
  --graders claude-sonnet-5-5 --only-concerns --spend-ledger .local/a16/ledger.jsonl --spend-cap 2.5 \
  --spend-headroom 0.1 --run-label a16-regrade-short-41 --out $S/regrade-a16-short-41.json        # each run
python3 -I packages/sim/lab/cl8/pooled.py eden+terse eden $S/a16-short-4{1,2} $S/a16-long-4{1,2}
python3 -I packages/sim/lab/a6/connector-price.py short $O/short-arms.txt long $O/long-arms.txt
```

`+terse` no longer exists (deleted, D335): the runs above were made at commit `9bcc4ee2` with the wording cut as §3
says (the trial's code is in `166b622c`, where it had been promoted before the review).

## Spend (`packages/sim/lab/a16/spend.txt`, cap $2.50)

| What | $ |
| --- | --- |
| pilots and smokes (72 tasks each) | 0.126 |
| session cache probe (two runs; the first's layouts read each other's prompts and are void) | 0.005 |
| short, three arms, seeds 41–42 | 0.416 |
| long, five arms, users 41–42 | 0.368 |
| concern regrades (Sonnet) | 0.015 |
| **Total** | **0.930** |

## Hermes with Eden in place of its source tools (three arms, run after A16)

Run by the coordinator on A16's `hermes-eden` condition: Hermes Agent (claude-haiku-5-5, Anthropic-direct lab
provider), train1–6 × 6 templates, hidden/control/neutral, seeds 41–42, payload notices, direct profile, time scale 1,
tip 9b0a… of 2026-11-07 15:27 UTC; recipe `packages/sim/lab/audit-1107/hermes/run3.sh`; reports
`hermes3-train-report.txt` and `hermes3-train-cost.txt` beside it. Spend $0.465.

| | hermes | hermes-eden | hermes+eden |
| --- | --- | --- | --- |
| Hidden raised | 7/72 (9.7%) | 59/72 (81.9%) | 52/72 (72.2%) |
| False concern (control / neutral) | 0 / 0 | 0 / 3 of 72 | 2 / 1 of 72 |
| Agent's own source calls a task | 2.70 | 0 | 2.16 |
| Wall p50, 1:1:8 mix | 4.90 s | 3.79 s | 5.74 s |
| $/1k steady (tokens), mix | 0.431 | 0.823 | 0.667 |
| $/1k mix, Zapier MCP plan | 71.5 | 0.82 + Eden's calls | n/a |

- **Eden as the agent's only context tool is the better Hermes shape:** +72 points hidden (+60..+83) and −1.4 s
  (−2.0..−0.8) against Hermes alone; against Hermes keeping its tools beside Eden, +9.7 points (+2.8..+18.1) and −1.5 s.
- **But Hermes pays more tokens with Eden than Pi does:** agent $/1k 0.610 against 0.440 at similar input counts (the
  plugin's per-turn context sits in the user turn, so Hermes re-writes its cache on every model call), and the cards'
  background spend in this run is $0.221/1k (cards not in the replay cache, paid live). Open item for the next session.
- **Connector pricing is incomplete here:** the Hermes harness records the agent's own source calls but not Eden's
  (`Eden conn/t` reads 0), so the per-plan rows for the Eden arms leave out Eden's connector calls. Pi measures them
  (0.16 a task on long horizons, A3/A8).
