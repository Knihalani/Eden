# F12: the candidate final Eden (integration scoreboard)

Status 2026-11-12, at the freeze. The integration session (F12) merged every F and G lever into one candidate,
measured it against main, and closed with the promotion PR this note arrived in: speculate on in the proxy (D1273),
`pushLookup` not promoted (D1252), and the funnel-flags flake fixed. Every other lever below reached main's default on
its own branch. The candidate's working files (`docs/profiles/candidate.json`, the lab's `--preset candidate`, and the
screen scripts in `packages/sim/lab/f12/`) stay on branch `claude/f12-candidate` and are not on main.

## The levers and where each stands

The evidence kinds are those the integrator set: (i) $0 structural; (ii) agent-side, served by subagents, which
carries over per D1140; (iii) check-prompt, served by subagents only, so an API confirmation is owed (D1104).

| Lever                                                                             | Session | Where                                                                                                                                                                                           | Evidence                                                    |
| --------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Request glossary (`requestGloss`)                                                 | F1      | main's default (D1153)                                                                                                                                                                          | (i), and a queue pair for neutral                           |
| Freshness floor (`syncActivePollMs` 7,200,000, `syncActivePollBackoff`)           | F3      | main's default (D1132, #313)                                                                                                                                                                    | (i), and a subagent pilot                                   |
| Rule sheet (`pushCheckSheet` 80, `pushCheckSheetRefs`; heavy-user guard D1183)    | F5      | main's default (D1180, #312)                                                                                                                                                                    | (iii)                                                       |
| Card state (`cardsState`, `pushStateFilter`)                                      | F2      | main's default (D1193)                                                                                                                                                                          | (i): decoys handed 746 → 543, facts 859 → 868 (F2's $0 run) |
| Lookup on a silent push, LK5 (`pushLookup` 3, `pushLookupAny`, `pushLookupQuiet`) | F11     | **candidate only** (`candidate.json`), trial D1252                                                                                                                                              | (ii)                                                        |
| Speculate (proxy)                                                                 | F10     | main, off (D1273)                                                                                                                                                                               | priced [EST], no live pair                                  |
| Deleted or rejected                                                               |         | `cardsKeepOnly` (D1181), `cardsRequestsWide` (D1154), `askCoverage` (D1251), `pushDecoyFilter` (D1143), `anticipate` (D1301), `pushCheckView` (D1271), F10's encoder (no live user, not merged) |                                                             |

## Interactions found

1. **`cardsRequestsWide` changed the run's coverage silently.** Its card form 4 had no shipped replay, so the funnel
   dropped from shipped to full coverage without an error. It was held out, then deleted (D1154).
2. **`cardsKeepOnly` and the card-structure filters.** Keep-only turned request-only `none` cards into real ones, so
   F2's filters (bit 1, then `pushStateFilter`, which acts on `none` cards) had fewer items to act on. Both F2's first
   filter and keep-only are gone.
3. **The before arm's engine does not know a candidate.** The final's before arm runs the candidate's harness on an
   older engine, so a lab preset must not import a new engine export. The profile is now a JSON file (57bc7f9ff).
4. **Merge resolutions.** The branches' trial rows and switch blocks met in `config.ts`, `config-check.ts` and
   `partner.ts`. Resolving them line by line lost a closing brace and comment delimiters once (fixed in cb79c7698);
   each merge since is checked with a cold `bun run check`.
5. **A flaky test.** `funnel-flags.test.ts`, "--neutral under --jobs", fails about one cold check in three on four
   cores (card calls 25 against 24): card-drain timing under load. It passes alone and on a rerun.

## Queue run: candidate against main (served by subagents, D1101; single-shot)

`packages/sim/lab/final/go.sh` with BEFORE=6ab37001e (main before F2's merge), FINAL=57bc7f9ff (the same main with
F11's code) and FINAL_CONFIG=candidate. dev20, seed 41, hidden, control and neutral, 480 tasks an arm, every model call
through the queue: 2,455 answers from Haiku and Sonnet `queue-worker` subagents, `--single-arm` takes (F7's format
hazard), the harness with #315's fix. Both Eden arms run the same check prompts, so the difference is LK5 alone.
Compare arms within the run only.

```
== per arm (graded tasks)
  raw      hidden raised 18/160 (11.2%)  control concerns 0/160 (0.0%)  neutral concerns 24/160 (15.0%)  ungraded 0
  before   hidden raised 81/160 (50.6%)  control concerns 3/160 (1.9%)  neutral concerns 53/160 (33.1%)  ungraded 0
  final    hidden raised 78/160 (48.8%)  control concerns 3/160 (1.9%)  neutral concerns 45/160 (28.1%)  ungraded 0

== paired differences (points; 95% CI, templates resampled; pairs, templates, up/down)
  final - before  hidden     -1.9 (-4.4..+0.0)  n 160, 160 templates, 0 up / 3 down
  final - before  control    +0.0 (+0.0..+0.0)  n 160, 160 templates, 0 up / 0 down
  final - before  neutral    -5.0 (-10.0..+0.0)  n 160, 160 templates, 6 up / 14 down
  final - raw     hidden    +37.5 (+29.4..+45.6)  n 160, 160 templates, 63 up / 3 down
  final - raw     control    +1.9 (+0.0..+4.4)  n 160, 160 templates, 3 up / 0 down
  final - raw     neutral   +13.1 (+5.6..+20.6)  n 160, 160 templates, 31 up / 10 down
  before - raw     hidden    +39.4 (+31.2..+48.1)  n 160, 160 templates, 66 up / 3 down
  before - raw     control    +1.9 (+0.0..+4.4)  n 160, 160 templates, 3 up / 0 down
  before - raw     neutral   +18.1 (+10.0..+26.2)  n 160, 160 templates, 38 up / 9 down


== stage of each hidden fact (Eden arms, graded hidden tasks)
  before  raised 81 (51%); reached, not raised 15 (9%); dropped by the push check 3 (2%); never retrieved 61 (38%); uptake (raised | reached) 79/94 (84.0%)
  final   raised 78 (49%); reached, not raised 15 (9%); dropped by the push check 3 (2%); never retrieved 64 (40%); uptake (raised | reached) 76/91 (83.5%)

before (run f12-before, 480 tasks) [EST; served by subagents (D1101)]
  eden.check: 328 calls, 0.683 a task; a call 3736 in (980 cacheable), 34 out, $0.000313; $0.2142 per 1,000 tasks; modelled wait 474 ms a task
  all roles: $0.5319 per 1,000 tasks; path roles' modelled wait 1359 ms a task
final (run f12-final, 480 tasks) [EST; served by subagents (D1101)]
  eden.check: 328 calls, 0.683 a task; a call 3736 in (980 cacheable), 34 out, $0.000313; $0.2142 per 1,000 tasks; modelled wait 474 ms a task
  all roles: $0.5281 per 1,000 tasks; path roles' modelled wait 1352 ms a task
```

**Reading.** On single-shot, LK5 raised 3 fewer planted facts (−1.9 points, −4.4..+0.0; 0 up, 3 down), raised the
same concerns on control, and fewer on neutral (−5.0 points, −10.0..+0.0). The Eden-side cost and wait barely move
(−$0.004 per 1,000 tasks, −7 ms [EST]). Single-shot cannot see what LK5 is for: it gives the agent records so that the
agent does not search its own connectors. F11's multi-turn rounds measured that (connector calls −0.56 to −0.67 a
task). The final's multi-turn sample on heldout20 measures it again.

## $0 screens (no model, unchecked)

At $0 the push check fails open, so every "handed" figure here is the unchecked push. F1 measured the glossary with
the check answered through the queue (neutral 50 → 21, decoys +4 on non-English requests). The tables are in this
note's history (8323de796): the glossary alone moved dev20 +53 hidden, +43 decoys and +48 neutral packets surfaced,
unchecked. The floor moved request-path connector calls from 3.31 to 0.10 a task as the trial; promoted with its
cost guards, the figure is 3.23 on train and 3.53 on dev20, against main's 3.31 and 4.14. Push p99 at `--time 1` went
from 37.1 to 29.7 ms (train seed 41, `--jobs 1`). RSS a user moved from 1.44 to 1.50 MB live (`users.bench.ts 300
500`, trial profile).

## Tools

On branch `claude/f12-candidate`: `packages/sim/lab/f12/screen.sh` (both arms on the four suites), `arms.sh` (named
arms over a preset, three at a time) and `board.py` (the table). On main: F6's `packages/sim/lab/final/go.sh` and
`report.sh`, which ran the queue run.
