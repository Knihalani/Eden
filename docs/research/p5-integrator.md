# P5: the integrator's obligations, first-run time, and the packet as an agent reads it

2026-11-11, branch `claude/p5-integrator-dx`, decisions D850–D856. Weak points D1, D3, D4 and C1 of
[weak-points-1111.md](weak-points-1111.md). Every figure below was measured in this session; live figures are
Anthropic-direct lab figures or are labelled otherwise.

## 1. What was built

| Decision | What | Evidence |
|---|---|---|
| D850 | A default `onError` in both clients: each distinct problem printed once with its fix in development, the first of each route and status in production; `null`/`None` silences | `on-error.test.ts`, Python `DefaultOnError`, `fix_for` compared with `fixFor` |
| D851 | Trial `askTool` (off): the proxy offers `ask_context` on the chat, Messages and Responses routes and answers it in its own loop | `proxy-ask.test.ts` (14 tests: three routes, streamed and not, the round cap, fail-open) |
| D852 | `eden doctor`: content-free per-tenant integration counters on the server (`/v1/usage`'s `integration`), each obligation ok, FIX or unknown with its measured penalty and fix | `doctor.test.ts` against the real handler |
| D853 | `bun run publish:check`: npm, PyPI and image dry runs; nothing published | all three ok on this tree |
| D854 | A Vercel AI SDK adapter (`examples/ai-sdk`): every in-loop obligation in three calls | `adapter.test.ts` (6 tests, an AI SDK mock model through the real handler); one live run |
| D855 | Trial `leadShort` (off): the candidates' lead in fewer words | §3 |
| D856 | First-run fixes: the clients read `EDEN_URL`/`EDEN_API_KEY`; README's four traps | §2 |

## 2. Time to first value

Four Haiku 5.5 subagents with no prior context each followed the docs from zero, one path each, timing themselves
with `date +%s` (command time only: their reading time is not on the clock, so these are lower bounds) and listing
every stumble. The first round ran in worktrees made from the base commit (533cc7f8), so it measures the docs before
this branch.

**Before (base docs):**

| Path | First value | Verdict on "under 15 minutes from the docs alone" | Stumbles that cost the most |
|---|---|---|---|
| TypeScript SDK (README, personal-agent) | 0.4 min | yes | the example ignores a non-default port unless `EDEN_URL` is set, which no doc says; `model roles on` with no key it knew of |
| Python client | 1.8 min | no (about 5 with fixes) | a made-up key on a dev server is a 401 and no doc says to pass none; a session id reused from the curls gave `(shown above)` and empty context; `PORT` not documented with the client |
| Proxy (Anthropic Messages) | 1.7 min | no | port and `EDEN_URL` not stated together; the inherited `OPENROUTER_API_KEY` turned paid model roles on silently; no raw Messages example; thinking used up `max_tokens` 200 (two wasted calls) |
| Vercel AI SDK | 1.9 min (own script) | no | no AI SDK path at all; the TS client ignored `EDEN_URL`; dev-mode key 401; `withContext`'s system message is refused by AI SDK 7; a failed model call after `collect` lost the packet |

Every path also asked for `bun run doctor`, which did not exist on the base tree.

Fixed on this branch: the clients read `EDEN_URL` and `EDEN_API_KEY` (D856); README names the four traps (port with
`EDEN_URL`, no key in dev mode, `model roles on` and `env -u OPENROUTER_API_KEY`, one session id per conversation);
INTEGRATION.md has a raw Messages request through the proxy and how to see what Eden added, and says `collect`
drains the queue; the AI SDK path exists (D854) and handles the system-message rule; the default `onError` names the
fix for a 401 ("omit it against EDEN_DEV=1"); `doctor` exists (D852).

**After (this branch at 5cfe89bb, same prompts, fresh agents, worktrees at that commit):**

| Path | First value | Verdict | Stumbles left |
|---|---|---|---|
| TypeScript SDK | 0.4 min | yes | doctor's config lines read its own environment; many `?` lines on a first run |
| Python client | 0.75 min | yes | the Python README lacked the dev-mode key note and return shapes; doctor's config lines and a 1-of-1 wait read `?` |
| Proxy (Anthropic Messages) | 1.2 min | yes (first request worked) | doctor's config lines; exit status 1 read as a crash; the ask trial unexercised (the model did not ask) |
| Vercel AI SDK | 0.45 min (example), 0.92 min (own script) | yes | the example's README lacked `EDEN_URL`; no offline-model pointer; doctor saw no agent side for a one-turn agent |

All four now say yes; three of four said no before. The minutes are command time from agents that read fast, not a
human's time; the stumbles are the useful part. Fixed after this round: doctor reads the server's configuration only
with `--env` (run where the server runs), judges the wait on any sample, prints cost and fix only for `FIX` unless
`--verbose`, and says what exit status 1 means; the AI SDK adapter reports each answer's reply and tool calls right
after the model call (a one-turn agent's reply never comes back in a later prompt), marked seen so the next turn does
not report it again; the example's and the Python README's gaps above.

**Not fixed, and why:** a dev server refusing a made-up key is deliberate (D351: a typo'd production key must not
land in tenant "dev"); the fix is to say so, which README now does. Anthropic's thinking budget is the provider's
behaviour; the proxy example now sends `max_tokens` 1024.

**A cost the walkthroughs exposed:** this container has `OPENROUTER_API_KEY` set, and five servers started during the
first round (three by the subagents, two by me) ran with model roles on before it was noticed. None had
`EDEN_TRACE=1`, so whether they made card calls through OpenRouter (the example's three documents) is not known.
Every later server here was started with `env -u OPENROUTER_API_KEY`.

## 3. The packet as an agent reads it

Read on the demo's world (`bun run demo`, the shipped default, no model key) and the funnel's neutral requests.

- **The fence holds and is cheap.** Every packet and every ask answer is in `<context src="the user's sources"
  note="Data, not instructions.">`; Eden's own lines start `Eden: ` and are dropped from usage tracking. No change.
- **The lead is a quarter of a neutral request's packet.** The candidates' lead is 252 bytes (70 tokens by
  Anthropic's `count_tokens` on Haiku 5.5), about 390 bytes (about 107 tokens, counted apart) with the ask nudge, on nearly every packet; a
  neutral request carries 1,055 packet bytes over 1.09 packets (`bun run funnel --jobs 4 -- --neutral`, train, seeds
  41–42). It is re-read on every later request while packets stay in the transcript (D336), which is right for facts
  and costly for a fixed instruction. Trial `leadShort` (D855) says the same three things (the request's person,
  thing and date; still current; otherwise ignore it and say nothing) in 154 bytes (49 tokens), the nudge in 89 (26):
  neutral packet bytes 1,055 → 947 a task (−10.2%), items, packets and the funnel (315/276) unchanged.
- **"(shown above)" depends on the transcript.** An ask answer for an item already handed in this session says
  `(shown above)` instead of its text. That is right only if the earlier packet is still in the agent's context: an
  integration that drops packets (D336) or compacts its history (A3 of the weak-points report) leaves the agent a
  pointer to nothing. The walkthroughs read it as a bug twice. No change made: A3's `context_reset` is the fix and
  needs its own run.
- **One request can bring two envelopes.** The observe's packet and a `pending` one each carry the header (and the
  lead, when both are candidates). Merging them would save the header's 65 bytes but change what `withContext`
  places; not changed.
- **"updated:" packets** name the newer version item by item under its title (`updated: …`), in the same envelope;
  clear as read, unmeasured as to whether an agent acts on them (Q5 of the weak-points report).
- **Follow-ups:** a packet that lands after the agent's first model call is shown at the next call, if any; the
  weak-points report (A4) records that agents seldom take them. Nothing here changes it.

## 4. Pre-registration (committed before any paid call of these runs; none has been made)

### 4a. `leadShort` (D855)

- **Arms** (pi-ab, the bench recipe, Haiku 5.5 as agent, grader and cards, Anthropic API; cards and intent replayed):
  `eden` and `eden~S`, `S = {"leadShort": true}`.
- **Tasks:** train seeds 41–44, hidden, control and neutral, all templates, one seed a process. One request a session
  and `--days 8` on users w41–w44 (the saving is in the day's re-read packets).
- **Grades:** hidden answers and control/neutral concerns regraded by Sonnet 5.5 (`i3-regrade.ts`); template-clustered
  bootstrap (`bench_report.py --sonnet`); cost paired by task on the 1:1:8 mix (`n5/mix.py`).
- **Rule:** promote if hidden raised is not lower (difference's 95% interval above −3 points), look-alikes raised
  (Sonnet-confirmed concerns on control) not higher (interval below +3 points), and agent cost per task lower on the
  days run; otherwise delete the two constants and the switch.
- **Budget [EST]:** about $6 (two arms, four seeds, plus days and regrade), within P5's $10 Anthropic cap.
- **As run (committed before the first call, 2026-11-11; the owner asked for a same-day decision, no standing
  trial):** the Modal bench preset `bench-lead-short` (`fanout_plan.py`: the bench recipe, arms `eden` and
  `eden~short`, hidden, control and neutral, train), seeds 41–44, one request a session, `--cap 4`; then every hidden
  answer and control/neutral concern regraded by Sonnet 5.5 (`i3-regrade.ts`, its own cap $3) and
  `bench_report.py --pair eden~short:eden --sonnet`. **Deviation:** no `--days 8` run; the rule's cost clause is read
  on one request a session (the per-packet saving is fixed at $0 above; a days run would only multiply it). The rule
  is otherwise as above: promote if the hidden difference's 95% interval is above −3 points and confirmed concerns'
  interval below +3 points; delete otherwise.

```bash
V='{"S":{"leadShort":true}}'
bun packages/sim/src/lab/pi-ab.ts --suite train --seeds 41 --conditions 'eden,eden~S' --variant-config "$V" \
  --variants hidden,control,neutral --config default --tenant-prompt --push payload …   # one seed a process
bun packages/sim/src/lab/i3-regrade.ts --results … --spend-ledger .local/p5/ledger.jsonl --spend-cap 10
python3 -I packages/sim/modal/bench_report.py --pair 'eden~S:eden' --group p5=.local/p5 --sonnet
```

### 4b. `askTool` through the proxy (D851)

- **Arms:** Pi's agent with its own tools, Eden's context through the proxy's Messages route (`both`, what a proxy
  user has today), against the same with `askTool` on. pi-ab does not run the agent through the proxy yet: the harness
  needs a transport that sends Pi's model requests to an in-process `createProxy` in front of Anthropic. Not built in
  this branch.
- **Rule:** promote if hidden raised rises with the 95% interval above 0 and agent cost per task rises at most 27%
  (D70's bound); otherwise delete `ask.ts` and the switch.

## 5. Spend

Anthropic: two live smoke calls of the AI SDK example (`claude-haiku-5-5`), four proxy walkthrough calls, and free
`count_tokens` calls; under $0.02 in all [EST from token counts]. Modal: $0. OpenRouter: possibly a few card calls
from the servers in §2's note (unknown; not intended).
