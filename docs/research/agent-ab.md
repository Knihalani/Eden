# Does Eden help an agent? Tools against Eden against both

Status: 2026-10-30. One run of `packages/sim/src/lab/agent-ab.ts`, live models through OpenRouter. The question the
owner asked: is Eden useful to an agent, or could the agent's builder get the same by giving it search tools?

## Setup

- **Worlds.** Five simulated users (seeds 41–45), ≈1,500 items each over mail, calendar, documents, CRM and chat,
  behind the realistic connector profiles (the same search semantics, latencies and failures the simulation uses).
- **Tasks.** The first 30 tasks per world that need facts from the sources: 93 requests ("What time is my Berlin
  flight?", "Where are we with the Umbrella Health deal?") and 35 arriving messages ("New email from Pied Piper:
  invoice INV-1332 is overdue", given to the agent as "tell the user what they need to know"). Plus 18 off-world
  requests ("write a haiku") to see what each condition costs when the sources do not help.
- **Agent.** `z-ai/glm-5.3-flash` (Eden's default model), temperature 0, up to 6 model calls per task, the same
  system prompt in every condition.
- **Conditions.**
  - none: no access to the user's data.
  - tools: a `search_<source>` tool per source, 5 results of 600 characters each.
  - eden: Eden beside the agent (context injected before the model call, `ask_context` as the only tool); no model.
  - both: the search tools and Eden's injected context; Eden sees the agent's tool results.
  - eden-judge, both-judge: as eden and both, with Eden's judge on (GLM 5.3 Flash, after D45).
  Each Eden runs a world's tasks in order, as it would in use (its cache and planner warm up).
- **Grading.** `anthropic/claude-haiku-5.5` (another family than the agent) reads each answer and marks which needed
  facts it states, specifics matching. A lexical check (70% of a fact's distinctive tokens present) agrees with it on
  783 of 882 facts (0.888).

## Results

Fact recall is the share of needed facts the answer states; success is all of them. Cost is OpenRouter's reported
cost per 1,000 tasks, agent and Eden's judge together.

**Requests** (93):

| Condition | Fact recall | Success | Model calls | Tool calls | Input tokens | Cost / 1k tasks | p50 |
|---|---|---|---|---|---|---|---|
| none | 0.000 | 0.000 | 1.00 | 0 | 83 | $0.054 | 2.4 s |
| tools | 0.817 | 0.763 | 2.76 | 4.06 | 2,520 | $0.197 | 4.6 s |
| eden | 0.742 | 0.720 | 2.06 | 1.44 | 1,503 | $0.161 | 4.4 s |
| both | 0.823 | 0.785 | 2.48 | 3.53 | 2,274 | $0.184 | 4.7 s |
| eden-judge | 0.753 | 0.720 | 1.95 | 1.24 | 1,513 | $0.170 | 4.3 s |
| both-judge | 0.844 | 0.806 | 2.46 | 3.33 | 2,438 | $0.215 | 4.6 s |

**Arriving messages** (35):

| Condition | Fact recall | Model calls | Tool calls | Input tokens | Cost / 1k tasks | p50 |
|---|---|---|---|---|---|---|
| none | 0.000 | 1.00 | 0 | 120 | $0.071 | 3.6 s |
| tools | 0.771 | 3.06 | 5.43 | 3,296 | $0.285 | 6.9 s |
| eden | 0.714 | 2.03 | 1.51 | 1,708 | $0.213 | 7.1 s |
| both | 0.686 | 2.69 | 4.06 | 2,806 | $0.285 | 7.9 s |
| eden-judge | 0.800 | 2.03 | 1.43 | 1,769 | $0.224 | 7.2 s |
| both-judge | 0.686 | 2.83 | 4.20 | 2,921 | $0.267 | 6.8 s |

**Off-world** (18): Eden injected nothing, except once in 18 with both-judge; cost $0.067–0.095 per 1,000 tasks
across conditions. No answer in any condition contained a planted secret.

Paired differences in fact recall against tools (same tasks; bootstrap 95% interval):

| | All (128) | Requests (93) | Arrivals (35) |
|---|---|---|---|
| eden − tools | −0.070 (−0.148…+0.004) | −0.075 (−0.151…−0.005) | −0.057 (−0.257…+0.143) |
| both − tools | −0.020 (−0.070…+0.031) | +0.005 (−0.043…+0.054) | −0.086 (−0.229…+0.057) |
| eden-judge − tools | −0.039 (−0.121…+0.039) | −0.065 (−0.145…+0.016) | +0.029 (−0.171…+0.200) |
| both-judge − tools | −0.004 (−0.059…+0.055) | +0.027 (−0.016…+0.070) | −0.086 (−0.257…+0.086) |

The lexical check gives tools, eden and both the same request recall (0.694 each): part of the grader's differences
between them may be grading noise.

## What it says

- **A capable model with search tools does as well as Eden, or better.** Eden in place of tools found 7 points fewer
  of the facts requests needed (the one interval that excludes zero). Eden beside tools added nothing measurable: every
  "both" interval spans zero.
- **Eden is cheaper per task.** In place of tools it used 25–34% fewer model calls, 40–48% fewer input tokens, and
  cost 18–25% less, at the same latency. That is the measurable advantage, and it comes with the recall loss above
  (the judge narrows it on arrivals, within noise).
- **The judge matters for arrivals.** eden-judge has the best arrival recall (0.800 against 0.771 for tools, within
  noise) at 21% less than tools; with no judge Eden is behind.

## What it does not show

- The tasks are explicit lookups: the request names what it needs, which is the case search tools handle best. The
  case Eden is for — context the agent would not think to look up (a clash with tomorrow's meeting, a promise made in
  another thread) — is not in this task set, and the arrivals here tell the agent to act on them.
- One agent model, one simulated world family built by the same project, one run (live models vary run to run).
- Arrivals are 35 tasks: their intervals are wide.

## Reproduce

```bash
bun packages/sim/src/lab/agent-ab.ts --seeds 41,42,43,44,45 --tasks 30 --offworld 5 --judge --budget 3 --out ab.json
```

This run cost $0.30 in all (agent, Eden's judge and grading), in two passes: the first's grading was cut short by a
dropped connection and its judge conditions ran before D45; the second (`--merge`) graded the rest and re-ran those.
