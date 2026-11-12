# The F-wave final (12 Nov): heldout20, raw vs before vs final

The owner set four targets for the day:

1. Fewer decoys handed.
2. Hidden facts found and given in the 90s.
3. Agent + Eden no dearer than the agent alone. During the day this was relaxed to "match".
4. Agent + Eden no slower than the agent alone. This was also relaxed to "match".

This note gives the one read of `heldout20` (F4, D1080), the blind suite written for the wave and unread until this run. It
compares three arms:

- **raw**: the agent with its tools only.
- **before**: Eden at 006b505c, this morning's default.
- **final**: main at bbd84a1b, the default after the wave.

**How it was served.** Every model answer came from subagents, not the API (D1101): Haiku for the agent and Eden's check,
Sonnet for the grader. The Anthropic account had no credit. Read the levels as subagent levels: D1140 and D1104 say
agent-side arms carry over, but check-prompt wording arms do not. Every $ and wall figure is an estimate [EST] from the
queue's sizes and Haiku list prices (cost.py, wall.py). The single-shot rows are 4 seeds × 48 templates; the multi-turn
sample is seed 41 only, 40 tasks per kind. The run took 13:33–14:59 UTC with about 90 worker agents and no format failures.
Full output is on `claude/final-results`, file `packages/sim/lab/final/results/heldout20-report.txt`. Recipe:
`packages/sim/lab/final/README.md`.

## Results

Single-shot, 192 tasks per kind per arm, 0 ungraded:

| Arm    | Hidden raised   | Control concerns (look-alike raised) | Neutral concerns |
| ------ | --------------- | ------------------------------------ | ---------------- |
| raw    | 8 (4.2%)        | 0                                    | 46 (24.0%)       |
| before | 99 (51.6%)      | 3 (1.6%)                             | 40 (20.8%)       |
| final  | **141 (73.4%)** | **2 (1.0%)**                         | 38 (19.8%)       |

Paired differences in points, with 95% CIs over the 48 resampled templates:

| Comparison     | Hidden                                       | Control             | Neutral             |
| -------------- | -------------------------------------------- | ------------------- | ------------------- |
| final − before | **+21.9 (+9.9..+33.9)**, 50 up / 8 down      | −0.5 (−3.6..+2.1)   | −1.0 (−9.9..+7.3)   |
| final − raw    | **+69.3 (+56.8..+80.7)**, 133 up / 0 down    | +1.0 (+0.0..+2.6)   | −4.2 (−17.7..+8.9)  |

The stage of each hidden fact:

| Arm    | Raised | Reached, not raised | Dropped by the check | Never retrieved | Uptake |
| ------ | ------ | ------------------- | -------------------- | --------------- | ------ |
| before | 52%    | 1%                  | 0%                   | 47%             | 98%    |
| final  | 73%    | 0%                  | 4%                   | 22%             | 100%   |

F6 checked the uptake figures task by task. On dev20 uptake was 75–81%, so this suite rewards retrieval more than
wording. The final's gain over before came from retrieval: "never retrieved" fell from 47% to 22%.

Late checks [EST]: if 21% of checks finish after 1.5 s on the API (F7), final's 141 reads about 133. A late check would
also hand about 11.8 more look-alike exposures.

Hidden raised by area, raw → before → final:

| Area   | raw   | before | final |
| ------ | ----- | ------ | ----- |
| admin  | 0     | 33%    | 67%   |
| family | 0     | 50%    | 58%   |
| health | 0     | 42%    | 83%   |
| home   | 0     | 58%    | 67%   |
| money  | 0     | 33%    | 58%   |
| social | 17%   | 83%    | 92%   |
| travel | 17%   | 54%    | 83%   |
| work   | 0     | 58%    | 79%   |

### Multi-turn sample

Real Pi loop, seed 41, 40 tasks per kind:

- Hidden raised: raw 2/40, final 27/40.
- Control concerns: 0 and 1.
- Neutral concerns: 5 and 3.

The final agent makes 1.48 model calls and 0.78 tool calls per task, against raw's 1.77 and 1.48.

## The four targets

**1. Decoys handed: met, not by the stretch margin.** Look-alikes the agent raised:

- final 2/192 against before 3/192;
- raw 0/192;
- multi-turn 1/40.

On the no-model funnel, F2's card state (D1193, with G2's lift-notice fix, D1456) cut decoys the push hands by
−24% across train, reworded, longtail and dev20. G2's `packetHeedsCheck` (D1450) cut unasked rule-path look-alike
packets from 30 to 2 of 640 and neutral packets by 35%.

Not met: G2's −60% bar on look-alikes handed by the ask. Every lever that reached it also lost raised facts (D1452).

**2. Hidden facts in the 90s: not met.** The result is 73.4% single-shot (about 69% late-check adjusted) against 4.2% raw
and 51.6% before. What is left:

- 22% is never retrieved. These are world-knowledge bridges with no word or day in common with the request (F13,
  D1302). Every meaning bridge tried so far also pulls in the look-alike twin.
- 4% is dropped by the check.

**3. Cost no higher than the agent alone: met only where connector calls cost money or the agent's prompt is large.**
On model spend at the lab's short prompt, the multi-turn sample reads [EST]:

| Rule sheet priced as | Agent + Eden $/1k | Agent alone $/1k |
| -------------------- | ----------------- | ---------------- |
| all read from cache  | 0.209             | 0.105            |
| 1-hour mix (0.75)    | 0.274             | 0.105            |
| uncached             | 0.332             | 0.105            |

Almost all of the gap is Eden's push check. The rule sheet (D1180) more than doubled the check's input. Eden halves the
agent's tool calls, from 1.48 to 0.78 a task, so on per-call connector plans the agent with Eden is cheaper [EST]:

- Zapier: $20.00/1k against $38.06/1k.
- Arcade: $7.75/1k against $14.75/1k.
- Composio: $0.23/1k against $0.44/1k.

G3 (D1500) found the default level with raw at roughly 15k more agent prompt tokens. No measured lever closes the
short-prompt gap without losing facts or adding decoys; the minus-check arm loses 7.5 points of hidden facts.

The shipped OpenRouter route caches nothing until D1196's probe has run (D1196 is on `claude/f7-cache`, unmerged), so production pays the uncached row until then.

**4. Speed no slower than the agent alone: met with `speculate` (D1273, now on in the proxy).** Final against raw,
paired over 120 tasks, modelled by wall.py [EST]:

| Connector round | Final alone           | With speculate         |
| --------------- | --------------------- | ---------------------- |
| measured        | +2.2% (−9.9..+17.2)   | −9.2% (−20.6..+5.5)    |
| 0.3 s           | +16.7% (+6.7..+28.1)  | +2.7% (−7.1..+14.2)    |
| 0.8 s           | +4.1% (−6.4..+16.8)   | −7.2% (−17.4..+5.5)    |
| 2 s             | −12.5% (−23.8..+1.8)  | −20.2% (−31.2..−6.0)   |
| 1:1:8 mix       | +8.6%                 | −8.8%                  |

Speculate is modelled here because the Pi harness does not go through the proxy. It costs about 0.46 aborted first calls
a task, roughly +$0.04/1k [EST]. Push wait went from 386 ms (before) to 562 ms (final): the check now reads the rule
sheet, and it runs on more requests.

## What is in final and not in before

Each item lists the decision, its owner, and its evidence.

- Non-English requests glossed into English, at no model cost: D1153 (F1). On reworded non-English requests, hidden
  delivered rose 88 → 112 and neutral packets fell 50 → 21.
- The rule sheet in the push check, with a guard above 80 rules (D1180, D1183, F5) and a 1-hour cache TTL (D1197, F7).
  The evidence is subagent-only; the API confirmation is owed (D1104).
- The freshness floor: active sources polled every 2 h with backoff, never sources billed per call or unmarked (D1131 to
  D1133, F3). On dev20, hidden 48 → 60 with look-alikes flat.
- Card state (cleared constraints leave the push pool) with the lift-notice fix: D1193 (F2) and D1456 (G2).
- Rule-path packets held back when the check read every item and approved none: D1450 (G2).
- Plans with a day open a push, with up to 3 of that day's items seated for the check, and better day reading: D1402
  (G1). On dev20, +2.5 points hidden raised.
- The pi-ab and hermes-ab harness fix: D1155 (F1). It is not a product change. It explains most of the morning's
  "reached, not raised" and lifts every Eden arm, before included.
- `speculate` on in the proxy: D1273 (F10, G4).

Rejected today, with the code deleted and the findings kept: pushLookup (D1252), freshenHanded (D1156),
cardsRequestsWide (D1154), the learned check skips (D1272, D1274), anticipation (D1301), askHeedsCheck and the `why`
field (D1452 to D1455), pushStateFilter's wide form (D1451), pushLookupUnchecked (D1552), and cardsKeepOnly and sheet
selection (D1181, D1182). See DEAD-ENDS.md.

## Caveats

- Everything above was served by subagents. Wording-sensitive parts, the rule sheet above all, still need an API
  confirmation when credit returns.
- The multi-turn sample is one seed of 40 tasks per kind, so its cost and wall intervals are wide.
- The uptake difference between heldout20 (100%) and dev20 (75–81%) is checked, not explained. Levels from one blind
  suite do not transfer one-for-one.
- `REALISM=heavy` was not run on heldout20. On dev20 (F8) the check held silence less well with 600 noise items:
  neutral packets after the check went from 24 to 55 of 160.
