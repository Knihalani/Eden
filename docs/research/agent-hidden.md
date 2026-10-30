# Context the agent was not asked for: tools against Eden

Status: 2026-10-30. One run of `packages/sim/src/lab/agent-ab.ts --suite hidden`, live models through OpenRouter.
The follow-up to [agent-ab.md](agent-ab.md), whose tasks named what they needed. Here they do not: this is the case
Eden is for.

## Setup

Ten request templates (`packages/sim/src/lab/hidden-context.ts`), each an action whose answer depends on something it
does not ask about. Each plants one item stating the hidden fact in a simulated world of ≈1,500 other items:

| Template | The request | Planted |
|---|---|---|
| calendar-clash | dinner with a friend on Thursday 29 Oct at 19:00 | calendar: parents' evening that night, 18:30-20:30 |
| already-paid | a supplier says invoice INV-… is overdue, pay it | mail: payment confirmation for it, yesterday |
| dietary | book a table with a friend (first name) on Saturday | mail from them: vegan since September |
| legal-hold | tell a client we'll ship the SSO integration next month | Slack #legal: no delivery dates to their org until the MSA is signed |
| out-of-office | ask a colleague (first name) to review the deck by Friday | mail: their auto-reply, on leave until 16 Nov |
| travel-clash | accept a client's workshop on Wednesday 4 Nov at 10:00 | calendar: a 07:10 flight to Madrid that day |
| discount-cap | offer a client 15% off to close the renewal | Slack #finance-approvals: above 10% needs CFO sign-off |
| allergy | order chocolates for a friend's (first name) birthday | Drive "People notes": severe nut allergy |
| moved-call | remind a client about our 3pm call tomorrow | mail from them: can we move it to 4:30pm? |
| already-sent | send a colleague the Q3 report | mail: sent it to them this morning at 08:12 |

Eight worlds (seeds 41–48), 80 tasks. Same agent (GLM 5.3 Flash), conditions and grader (Claude Haiku 5.5) as
agent-ab.md; the system prompt adds that the agent cannot act itself and should say what it would do. The grader
marks the hidden fact true only if the answer raises it; the lexical check agrees on 470 of 480 (0.979).

## Results

| Condition | Raised the hidden fact | Model calls | Tool calls | Input tokens | Cost / 1k tasks | p50 |
|---|---|---|---|---|---|---|
| none | 0.013 | 1.00 | 0 | 112 | $0.064 | 4.2 s |
| tools | 0.362 | 3.11 | 4.86 | 2,761 | $0.229 | 7.5 s |
| eden | 0.200 | 2.15 | 1.51 | 1,584 | $0.187 | 7.9 s |
| both | 0.350 | 2.81 | 4.03 | 2,498 | $0.242 | 6.7 s |
| eden-judge | 0.237 | 2.16 | 1.52 | 1,759 | $0.228 | 7.1 s |
| both-judge | 0.400 | 2.90 | 4.09 | 2,774 | $0.253 | 8.2 s |

Paired differences against tools (bootstrap 95% interval over the 80 tasks): eden −0.163 (−0.275…−0.063),
eden-judge −0.125 (−0.237…−0.013), both −0.013 (−0.087…+0.075), both-judge +0.037 (−0.050…+0.125).

By template, tasks where the hidden fact was raised (of 8; none / tools / eden / both / eden-judge / both-judge):

| Template | none | tools | eden | both | eden-judge | both-judge |
|---|---|---|---|---|---|---|
| calendar-clash | 0 | 8 | 0 | 8 | 0 | 8 |
| already-paid | 0 | 7 | 8 | 8 | 8 | 8 |
| already-sent | 0 | 8 | 5 | 8 | 3 | 7 |
| allergy | 1 | 2 | 2 | 3 | 5 | 7 |
| out-of-office | 0 | 2 | 0 | 0 | 2 | 1 |
| travel-clash | 0 | 2 | 0 | 1 | 0 | 1 |
| moved-call | 0 | 0 | 1 | 0 | 1 | 0 |
| dietary, legal-hold, discount-cap | 0 | 0 | 0 | 0 | 0 | 0 |

## What it says

- **Even here, Eden in place of tools is worse.** An agent with search tools raised the hidden fact on 36% of
  tasks; with Eden instead, 20% (24% with its judge). Both intervals exclude zero. The agent with tools checks its
  calendar before booking and its mail before paying or sending; Eden does neither of those checks for it.
- **Eden beside tools, with its judge, is the best condition (40%) but not by a margin this run can show** (+3.7
  points, −5.0…+12.5).
- **Where Eden helps is the one template no search finds:** the allergy note in a document. With tools, 2 of 8; with
  Eden and its judge beside the tools, 7 of 8. The agent does not think to search "Sam allergy" before buying
  chocolates; Eden matched the name to the note and the judge kept it.
- **A gap in Eden, not in the idea:** Eden never caught the calendar clash (0 of 8 in every Eden-only condition).
  "Set up dinner on Thursday at 19:00" keeps its words (D44 sends a time listing only for a request of nothing but
  time words), so Eden never fetched Thursday's calendar, and the judge, seeing no clash, said the evening was free.
- **Nobody catches dietary, legal-hold or discount-cap.** The hidden item names the friend by first name only, or
  the client's org but not the person asked about, or no one at all (a policy). Neither the agent's searches nor
  Eden's retrieval reach them.

## What it does not show

- Ten hand-written templates, planted one per world: a sample of the case, not its distribution. The planted text
  was written knowing what Eden and tools match on.
- One agent model, one run; 8 tasks per template, so per-template counts are rough.
- Eden is measured as built today. The calendar gap above has a direct fix (list the named day for a scheduling
  request), not measured here.

## Reproduce

```bash
bun packages/sim/src/lab/agent-ab.ts --suite hidden --seeds 41,42,43,44,45,46,47,48 --judge --budget 1 --out h.json
bun packages/sim/src/lab/agent-ab-report.ts h.json
```

This run cost $0.147 (agent, Eden's judge and grading).
