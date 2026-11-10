# N3: late packets, plan alerts at scale, earlier packets shortened, a late re-invitation to ask

Status: 2026-11-10, branch `claude/n3-long` (from `claude/lucid-hypatia-v9wqk5` at 3e10a6fe). Decisions D515–D519.
Train only (`heldout18` is unread and stays so). Paid calls: Anthropic only, the Modal Secret `HAIKU_API_KEY`,
`claude-haiku-5-5` in every role, `claude-sonnet-5-5` only to regrade, lab provider (D97): **Anthropic-direct lab
figures**. Caps: Anthropic $10, Modal $15.

## 0. Pre-registration (committed and pushed before any paid call)

### The four problems

1. **Follow-up packets never reach the agent live.** `askBehind`'s follow-up was taken in 0 of 432 tasks
   ([c4-ask-path.md](c4-ask-path.md)); B1's items found behind arrive after the agent's first model call
   ([b1-scale-path.md](b1-scale-path.md)). What was read before writing this: the lab's Pi harness
   (`transformContext` → `takePending`) and the proxy (`eden.pending()` in every request) **already** take what is
   queued before every model request, not only at a user message. The packet is missed because the request after
   an `ask_context` result starts as the result lands, before the reads behind have stored anything, and that
   request is usually the turn's last. So the lever is a wait at that take, not more takes.
2. **Late facts are raised in a later reply 7 of 16 times** ([a29-heldout17.md](a29-heldout17.md),
   [a9-ahead.md](a9-ahead.md), `planConflict`, D301), and M1's eight-seed run had no `--late` arm.
3. **Token gap over days:** +$0.026 per 1,000 tasks is earlier packets read back from the transcript
   ([a30-token-gap.md](a30-token-gap.md), D403); D336 keeps them because dropping them rewrote the cache and lost
   their facts.
4. **Asks stop after about four requests of a day** ([a17-long-quality.md](a17-long-quality.md)).

### Trials (D112: each a switch, off; promoted or deleted with its code and tests by the rule below)

| | Switch | What it does |
|---|---|---|
| H1 | `takeSettleMs` (engine, 0 = off; trial value 1,500) | `ContextPartner.settled(session)`: resolves when the session's work behind (an ask's reads, the push's poll and cut searches) is done, or after `takeSettleMs`. The harness awaits it before a model request **that follows a tool result in the same turn**, then takes what is queued. No wait before a turn's first request or when nothing runs behind |
| H2 | none (measurement of `planConflict`, D301) | `--day 6 --late` on eight seeds |
| H3 | harness layouts `+compact`, `+compactUsed` (as `+ephemeral` was, D336) | An earlier request's packet is replaced in place, once, at the next request, by its short form (the envelope, one fixed line of Eden's, each item line cut to 72 characters). `+compact`: every packet. `+compactUsed`: only a packet whose words the agent's answer to that request repeated (two words of five letters or more that the request did not hold, or one token of four or more characters with a digit). A packet changes at most once, so from the next request on the prefix is stable again |
| H4 | `askReinvite` (engine, off) | From a session's fifth request on, when the handed candidates do not settle the request's anchors (`settle.ts`, D316's test, whether or not `askNudgeDeep` finds more in the pool), the candidates' lead ends with a short line (`ASK_REINVITE`) in place of `ASK_NUDGE`. It invites an ask and says nothing against the candidates or the ask (D257, D335) |

H1 and H3 are built lab-first: the proxy and `@eden/client` get the behaviour only on promotion, in the same branch.

### Runs (Pi on Modal, `lab_fanout.py`, the M1 recipe: default config, `--tenant-prompt`, payload notices, direct
profile, time scale 1, replayed cards and intent for seeds 41–44, in-run for 45–48)

| Run | Shape | Arms | Seeds |
|---|---|---|---|
| `n3-late` (H2) | `--day 6 --late`, hidden and control | `tools`, `eden`, `eden~minus-plans` | 41–48 |
| `n3-days` (H3, H4) | `--days 8` | `tools`, `eden`, `eden+compact`, `eden+compactUsed`, `eden+askReinvite` | 41–44 |
| `n3-long` (H3, H4) | `--days 3 --day-size 40 --mix 1:1:3` (A17's stress days) | `eden`, `eden+compact`, `eden+compactUsed`, `eden+askReinvite` | 41–42 |
| `n3-settle` (H1) | one request a session, `--noise-sources 995`, `--limit 6`, hidden, control, neutral (C4's shape) | `eden`, `eden~settle` (`takeSettleMs` 1,500) | 41–42 |
| `n3-settle-days` (H1) | `--days 8`, five sources | `eden`, `eden~settle` | 41–42 |

At most two Anthropic shards at a time. Concerns (control and neutral answers Haiku graded as raising something,
and `--late` false alarms) are regraded by `claude-sonnet-5-5`; only confirmed ones count. Cost is reported on
market.py's connector plans (`pi-cost-report.ts`). Intervals: paired bootstrap 95%, 5,000 draws, clustered by
template where `bench_report.py` reads the shape, else by task with the user as the cluster for `--days`.

H1 short horizon is the 1,000-source shape because only there do reads run behind an ask (five sources fit the
sync cap: nothing is cut, C4 §3). H4 has no short-horizon run: with one request a session the switch cannot fire;
the funnel must be identical with it on (checked at $0). H3 has none either (one request: no earlier packet).

### Rules, fixed now

- **H1 `takeSettleMs`: promote** only if all hold on `n3-settle`: packets taken at a request after a tool result
  rise above the default's count; hidden facts paired ≥ 0.0 points; Sonnet-confirmed concerns up by at most 1.0
  point; Eden's time on the agent's path (the wait counted) up by less than 300 ms a task on the 1:1:8 mix; and on
  `n3-settle-days` hidden paired ≥ −2.0 points with wall not up by more than 0.2 s a task. **Else deleted.**
- **H2: a loss** is any of: late corrections (eden − minus-plans, hidden) with an interval that reaches 0;
  Sonnet-confirmed false alarms (control) up by more than 2.0 points; agent $ per task up by more than 10%.
  With no loss nothing is tuned. With a loss, one tuning trial is named in a decision and not run here unless the
  caps allow a fresh pre-registered pair.
- **H3: promote one layout** (into the proxy's `keepPackets` and `withContext`'s guidance) only if, for that
  layout: agent $/1k paired below zero with its interval below zero on `n3-long` and not above zero on `n3-days`;
  hidden facts paired ≥ −2.0 points pooled over both runs; and facts raised from a packet handed at an earlier
  request not lower by more than 2 tasks pooled. If both pass, the one with the larger saving. **Else both deleted.**
- **H4 `askReinvite`: promote** only if, pooled over `n3-days` and `n3-long`: hidden facts at requests 5 onward
  paired ≥ +3.0 points and all hidden ≥ 0.0; asks a task at requests 5 onward up; Sonnet-confirmed concerns up by at
  most 1.0 point; agent $/1k up by at most $0.010. **Else deleted.**
- A promoted switch needs `bun run check` green, `bun run eval` at 0.65 / 0.52 / 0 and the funnel at 314 / 274.
- No arm, seed, metric or threshold above changes after the first paid call; anything added later is labelled
  exploratory.
