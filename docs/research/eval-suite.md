# The eval suite

`bun run eval` plays the scenarios in `packages/eval/scenarios/` through the engine and scores each labelled turn
(D33: through the query planner by default; `--no-planner` without). Written 2026-10-28 for plan item 1
(docs/plans/next.md, ROADMAP M1).

## What is in it

- **26 scenarios, 125 turns, 89 scored**, hand-written, each its own small world (1–3 sources, 1–7 items, most with
  distractors that share words with the answer):
  - scheduling 5, inbox 4, follow-ups 3, purchases 3, relationships 3, travel 2;
  - adversarial 6:
    - a prompt injection in a supplier email;
    - planted secrets (a wifi password, and a database URL with an obviously fake password);
    - look-alike names;
    - entities only the agent mentions;
    - a fact the agent fetched with its own tool before the user asked;
    - requests the sources know nothing about.
- **Labels** say what an ideal partner does, not what Eden does today: the items to deliver by the turn or the next
  one, or silence. Silence is labelled where any delivery would be noise: small talk, agent chatter, an unrelated
  request, what the agent just fetched or read out, a newsletter arriving. An expected item the agent already got
  earlier in the session counts as met, since delivering it again would be a repeat.
- **Asks:** 3 questions asked directly (`ask`), scored on their citations. They also carry the secret check, which
  must not rest on proactive delivery alone.
- **Dates** follow the 2026 calendar (the eval's clock starts 1 Oct 2026).

## What it reports

- Overall and per-category precision, recall and false-fire rate.
- **Privacy:**
  - planted secrets;
  - deliveries and answers that cited an item holding one (`secretsExposed`: 0 means the check checked nothing);
  - how many of those carried the secret (must be 0);
  - deliveries and answers without the "Data, not instructions" framing (must be 0).
- The counts behind the rates (expected and found items, deliveries, silent turns, false fires).
- Ask recall, model calls and cost, latency, and the engine's decisions.

## Baseline (no model, 2026-10-28)

From `bun run eval` and `bun run eval --no-planner`, which give the same scores:

| Run | Precision | Recall | False fires | Secrets exposed, leaked | Not inert | Ask recall |
|---|---|---|---|---|---|---|
| planner (default) | 0.889 (16/18) | 0.348 (16/46) | 2/56 | 2, 0 | 0 of 19 | 1.0 (3 of 3) |
| no planner | 0.889 (16/18) | 0.348 (16/46) | 2/56 | 2, 0 | 0 of 19 | 1.0 (3 of 3) |

Per category, with the planner:

| Category | Scenarios | Scored turns | Precision | Recall | False-fire rate |
|---|---|---|---|---|---|
| adversarial | 6 | 20 | 1.000 | 0.500 | 0.000 |
| follow-ups | 3 | 9 | 1.000 | 0.500 | 0.000 |
| inbox | 4 | 15 | 0.600 | 0.500 | 0.182 |
| purchases | 3 | 8 | 1.000 | 0.000 | 0.000 |
| relationships | 3 | 9 | 1.000 | 0.167 | 0.000 |
| scheduling | 5 | 23 | 1.000 | 0.429 | 0.000 |
| travel | 2 | 5 | 1.000 | 0.200 | 0.000 |

- **Recall is the gap:** with no model, Eden stays silent on most need turns, as in the simulation (plan item 2).
  With 46 expected items, one item moves recall by 2.2 points.
- **Both false fires are one engine weakness:** when a newsletter arrives (an `external` event), Eden delivers that
  same email back to the agent, which already sees it in the event (`newsletter-arrives`). Added to the plan.
- **The planner makes no difference here.** The scenarios' sources are `StaticSource`s, which match any query term,
  so today's query already reaches everything. The planner's evidence is in the simulation's connector zoo and the
  connector lab (docs/research/query-planner-results.md).
- **The leak check fires:** a test declares ordinary delivered text a "secret" and expects it counted, on the
  delivery path and the ask path (`packages/eval/src/run.test.ts`).
- **The `--live` path is unmeasured:** the OpenRouter key's spend limit is used up, so model calls fail and the run
  measures the no-model path.
- **A first version had label errors,** found in review: items a good partner should deliver (a meeting's calendar
  entry, the overdue invoice email, a clashing train) were labelled wrong, and two labels asked for repeats. Its
  baseline (precision 0.875) measured the labels, not the engine; the numbers above are from the corrected suite.
