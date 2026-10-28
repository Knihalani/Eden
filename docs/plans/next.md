# Plan: what to build next (after the query planner)

Status: written 2026-10-28, after D33. One item at a time, ranked by what it unblocks; each is one or more PRs under
CLAUDE.md's workflow. Evidence for the ranking is from this repository's own runs (cited); nothing here is measured
yet unless it says so.

## Where things stand

- The query planner is built and on by default (D28–D33). Its loop continues (below), but it is no longer the
  biggest gap.
- **The eval could not see most changes.** Until item 1, `bun run eval` ran one scenario of 9 turns (7 scored); it
  scored the same with and without the planner (D33), so a regression in scoring or delivery would have passed
  unseen.
- **No-model delivery is the funnel's biggest loss.** In the simulation, most needed facts that are retrieved are
  never delivered when there is no model: on held-out A, seed 1, with the planner (the default), 84 of 178 needed
  facts were retrieved or cached and 34 delivered; the commonest decision on need turns was "silent: no model" (78 of
  143 turns; `bun packages/sim/src/quality-cli.ts --profile zoo-a --seed 1 --planner`, 2026-10-28). With a perfect
  judge in the model's place, recall roughly doubles (D33's evidence). The scoring thresholds (`confidentScore` 1.1,
  `candidateScore` 0.3, `entityBonus` 0.35) have never been tuned (ROADMAP M1).
- **The live model path is unmeasured**: the OpenRouter key's spend limit is used up, so `--live` makes no model call.
- Connector revocation (`forget(scope, sourceId)`, `POST /v1/forget` with `sourceId`) is already wired; `McpSource`
  had no `fetch` mapping, so cached items could not be refreshed (item 3 added one; the engine does not refresh yet).

## The plan

| # | Work | Why now | Exit |
|---|---|---|---|
| 1 | **An eval worth tuning against** (M1): 20+ hand-written scenarios across personal-agent jobs (scheduling, inbox triage, follow-ups, travel, purchases, relationships), many must-stay-silent turns, adversarial ones (prompt injection and planted secrets in source text); per-category metrics and a privacy check in the report | Every later item is judged by it | `bun run eval` reports per-category precision, recall and false fires, injection and secret counts; baseline numbers recorded |
| 2 | **Tune no-model delivery** (M1): `confidentScore`, `candidateScore`, `entityBonus` on a simulation train split, reported on held-out splits and on the new eval | The funnel's biggest loss; needs no model | Recall up beyond its interval with false fires not up (CLAUDE.md: a false-fire rise needs a decision), or a recorded "no gain" |
| 3 | **`McpSource` fetch mapping** (M2): refresh a cached item through the server's read tool when one exists | Stale items are served today | Schema-driven fetch mapping like search's; read-only check unchanged; tests |
| 4 | **The planner's learning cost**: it trails the best fixed shape by 0–10 points in the lab while it learns | The planner's largest remaining gap | Tune-set gain without held-out or lab regression |
| 5 | **Delivery and usage rewards for the planner** (plan, "Not done") | The immediate reward cannot tell shapes apart on OR and vector search | Measured in simulation, kept only if it helps |
| 6 | **Do not deliver what the agent has or does not need**: low-value mail arriving (a newsletter announced by an `external` event is delivered back) and items the agent just fetched with its own tool (delivered again when the user asks) | All three of the eval's false fires (`newsletter-arrives`, `agent-already-fetched`) | Those false fires gone, with no recall lost; `invoice-triage` (an arriving overdue invoice, worth delivering) still met |

Not in this plan, because each needs the owner first: OAuth and a token vault for real connectors (M2, whose
accounts and where credentials live: plan decision 1), real-account evidence for the planner (the owner chose
simulation, D29), tenant-level priors (D9), and production state (M5).

## Log

Each item, when done, gets a line here with its PR and its numbers.

- **1, the eval suite:** 26 scenarios (88 scored turns, 3 asks), per-category metrics, a privacy check. Baseline with
  no model: precision 0.833 (15/18), recall 0.349 (15/43), false fires 3 of 58 silent turns, secrets exposed 2 and
  leaked 0, deliveries and answers not inert 0 of 19 (docs/research/eval-suite.md). It surfaced two engine
  weaknesses (item 6).
- **2, no-model delivery:** lowering the bar for explicit requests (a scratch patch, not in the tree, so these
  figures cannot be rerun from it: an asked-for item needed a score of 0.9 instead of 1.1) raised recall: the eval
  16 to 21 of 46 items under the round-1 labels (commit d12c63a); held-out A and realistic in the simulation (5 seeds,
  `quality-cli --planner`) 18.8% to 23.1% and 19.1% to 25.0%. It also raised hard false fires there, from 1 to 5–6 of
  713 silent turns. The owner chose precision: no threshold change. Then a better no-model ranker (D36): with no
  model, the best candidate alone is delivered if it holds 3+ query terms and scores 0.8+ (chosen on zoo-tune).
  Held-out recall, no model: A 18.8% to 24.4%, B 23.3% to 28.5%, realistic 19.1% to 22.7% (paired intervals exclude
  0; fresh seeds 6–10 agree), hard false fires unchanged, precision mostly up but the soft-fire rate up on 6 of 7
  runs; with a perfect judge unchanged; eval recall 15 to 18 of 43 at precision 1.000
  (docs/research/no-model-fallback.md).
- **6, what the agent has or does not need (D34):** an item every one of whose terms and adjacent term pairs is in one
  recent tool result or agent message is not pushed, with or without a model; bulk mail (`meta.category` promotions, or
  a newsletter title) is not delivered without a model, and may cost a judge call where one would otherwise be delivered
  confidently. Eval: false fires 3 to 0 of 58, precision 0.833 to 1.000, recall unchanged (15/43); simulation (4 mixes,
  5 seeds): recall and false fires unchanged; observe p95 0.21–0.25 ms against 0.21–0.26 ms. No `--live` run (the key's
  spend limit).
- **3, `McpSource` fetch mapping (D35):** an optional, operator-configured read-one tool, under the same read-only
  check as search; arguments from its schema (or an `args` function), ambiguous schemas refused, Eden's content-hash
  refs never sent. Tests only: no real server's read-one tool was measured, and the engine does not call `fetch` yet
  (when to refresh a cached item is the next step for this item).
- **4, the planner's learning cost (D38):** a greedy cascade step and a runner-up prior for one call per entity.
  Against main with D37 (seeds 1–20): retrieval up on every mix (A 0.423 to 0.478, B 0.619 to 0.641, realistic
  0.406 to 0.473), recall with a perfect judge up on every mix, with no model up on B and realistic; calls +0.7–2.2%; no
  hard false fire. Measuring it found D37 (weekday names as entities). Lab: no
  connector lower beyond noise; CalDAV, IMAP, Gitea and Meilisearch up (docs/research/query-planner-results.md).
